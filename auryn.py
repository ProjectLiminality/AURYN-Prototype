# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "aiohttp>=3.9",
#     "mlx-whisper>=0.4",
#     "moonshine-voice>=0.0.49",
# ]
# ///
"""
AURYN — voice-first knowledge gardening agent.

Usage:
    uv run auryn.py serve [--port 8080] [--host 0.0.0.0] [--model qwen3:32b]
    uv run auryn.py context <file_or_text> [--top N] [--json] [--rebuild]
    uv run auryn.py search <text> [--top N] [--json]           (alias for context)
    uv run auryn.py index [--force]
    uv run auryn.py read <id|title|folder> [--deep]
    uv run auryn.py write <id|title|folder> --old <text> --new <text> [--message <msg>]
    uv run auryn.py create <title> [--readme <content>]
    uv run auryn.py pop-out <parent> --title <name> --readme <content> --old <text> --new <text>
    uv run auryn.py garden-state [--refresh]
    uv run auryn.py reveal <file_path>
    uv run auryn.py publish <id|title|folder>
    uv run auryn.py cc <id> <prompt> [--budget <usd>]
    uv run auryn.py clip <id|title|folder> --segments <json> --source <file>
"""

import argparse
import asyncio
import json
import math
import os
import pickle
import re
import shutil
import socket
import ssl
import struct
import subprocess
import tempfile
import time
import uuid
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

import aiohttp
from aiohttp import web

AURYN_DIR = Path(__file__).parent.resolve()
RECORDINGS_DIR = AURYN_DIR / "recordings"
TRANSCRIPTS_DIR = AURYN_DIR / "transcripts"
VAULT_DIR = AURYN_DIR.parent  # RealDealVault
INDEX_DIR = Path.home() / ".auryn"
INDEX_FILE = INDEX_DIR / "context-index.pkl"
CONTEXT_DIR = INDEX_DIR / "context"  # Ephemeral file uploads (auto-cleaned after 7 days)
CONTEXT_MAX_AGE_DAYS = 7
CHATS_DIR = AURYN_DIR / "chats"

# Pipeline debug log — written to file since stdout is piped by server.py
import logging
_pipeline_log = logging.getLogger("auryn.pipeline")
_pipeline_log.setLevel(logging.DEBUG)
_plh = logging.FileHandler("/tmp/auryn-pipeline.log")
_plh.setFormatter(logging.Formatter("%(asctime)s %(message)s", datefmt="%H:%M:%S"))
_pipeline_log.addHandler(_plh)
plog = _pipeline_log.info


# ============================================================
# Context Provider — Tier 1 (Vocabulary) + Tier 2 (BM25)
# ============================================================

# BM25 parameters
BM25_K1 = 1.5
BM25_B = 0.75


def _tokenize(text: str) -> list[str]:
    """Lowercase, strip punctuation, split into tokens."""
    text = text.lower()
    # Keep alphanumeric, hyphens within words, and unicode letters
    text = re.sub(r"[^\w\s-]", " ", text)
    text = re.sub(r"\s+", " ", text)
    return [w for w in text.split() if len(w) >= 2]


def _split_camel(name: str) -> list[str]:
    """Split camelCase/PascalCase into words. 'InterBrain' -> ['inter', 'brain']"""
    parts = re.sub(r"([a-z])([A-Z])", r"\1 \2", name)
    parts = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1 \2", parts)
    return parts.lower().split()


def discover_nodes() -> list[dict]:
    """Find all DreamNodes in the vault by scanning for .udd files."""
    nodes = []
    for udd_path in VAULT_DIR.rglob("*.udd"):
        # Only top-level vault entries (maxdepth 2)
        rel = udd_path.relative_to(VAULT_DIR)
        if len(rel.parts) > 2:
            continue
        try:
            data = json.loads(udd_path.read_text())
            node_dir = udd_path.parent
            readme_path = node_dir / "README.md"
            readme = ""
            if readme_path.exists():
                readme = readme_path.read_text(errors="replace")

            nodes.append({
                "uuid": data.get("uuid", ""),
                "title": data.get("title", node_dir.name),
                "type": data.get("type", "dream"),
                "folder": node_dir.name,
                "path": str(node_dir),
                "radicle_id": data.get("radicleId", ""),
                "readme": readme,
            })
        except (json.JSONDecodeError, OSError):
            continue
    return nodes


def build_index(nodes: list[dict] | None = None) -> dict:
    """Build the Tier 1 + Tier 2 index from scratch."""
    if nodes is None:
        nodes = discover_nodes()

    t0 = time.time()

    # --- Tier 1: Vocabulary lookup ---
    # Map normalized forms -> node info
    vocab: dict[str, list[dict]] = defaultdict(list)  # lowercase phrase -> [{uuid, title, ...}]

    for node in nodes:
        title = node["title"]
        folder = node["folder"]
        uid = node["uuid"]
        entry = {"uuid": uid, "title": title, "type": node["type"],
                 "path": node["path"], "radicle_id": node["radicle_id"]}

        # Exact title (lowered)
        vocab[title.lower()].append(entry)

        # Folder name (lowered)
        folder_lower = folder.lower()
        if folder_lower != title.lower():
            vocab[folder_lower].append(entry)

        # CamelCase-split folder words joined with spaces
        camel_words = _split_camel(folder)
        if len(camel_words) > 1:
            joined = " ".join(camel_words)
            if joined != title.lower() and joined != folder_lower:
                vocab[joined].append(entry)

        # Title without special spacing (e.g., "A U R Y N" -> "auryn")
        collapsed = re.sub(r"\s+", "", title).lower()
        if collapsed != title.lower() and collapsed != folder_lower:
            vocab[collapsed].append(entry)

    # Sort vocab keys longest-first for greedy matching
    vocab_phrases = sorted(vocab.keys(), key=len, reverse=True)

    # --- Tier 2: BM25 index ---
    # Tokenize all READMEs
    doc_tokens: list[list[str]] = []  # parallel to nodes
    doc_freqs: Counter = Counter()  # how many docs contain each term
    total_dl = 0

    for node in nodes:
        # Combine title + readme for the document
        text = node["title"] + " " + node["readme"]
        tokens = _tokenize(text)
        doc_tokens.append(tokens)
        total_dl += len(tokens)
        # Count unique terms per doc
        for term in set(tokens):
            doc_freqs[term] += 1

    n_docs = len(nodes)
    avgdl = total_dl / n_docs if n_docs > 0 else 1

    # Precompute IDF for each term
    idf: dict[str, float] = {}
    for term, df in doc_freqs.items():
        # BM25 IDF formula
        idf[term] = math.log((n_docs - df + 0.5) / (df + 0.5) + 1.0)

    # Precompute per-doc term frequencies and doc lengths
    doc_tf: list[dict[str, int]] = []
    doc_lens: list[int] = []
    for tokens in doc_tokens:
        tf = Counter(tokens)
        doc_tf.append(tf)
        doc_lens.append(len(tokens))

    elapsed = time.time() - t0

    index = {
        "version": 1,
        "built_at": time.time(),
        "n_docs": n_docs,
        "build_time_ms": round(elapsed * 1000),
        # Tier 1
        "vocab": dict(vocab),
        "vocab_phrases": vocab_phrases,
        # Tier 2
        "nodes": nodes,
        "idf": idf,
        "doc_tf": doc_tf,
        "doc_lens": doc_lens,
        "avgdl": avgdl,
    }
    return index


def save_index(index: dict) -> None:
    """Persist index to disk."""
    INDEX_DIR.mkdir(parents=True, exist_ok=True)
    with open(INDEX_FILE, "wb") as f:
        pickle.dump(index, f, protocol=pickle.HIGHEST_PROTOCOL)


def load_index() -> dict | None:
    """Load cached index from disk."""
    if not INDEX_FILE.exists():
        return None
    try:
        with open(INDEX_FILE, "rb") as f:
            index = pickle.load(f)
        if index.get("version") != 1:
            return None
        return index
    except (pickle.UnpicklingError, EOFError, KeyError):
        return None


def ensure_index(force: bool = False) -> dict:
    """Load or build+save the index."""
    if not force:
        index = load_index()
        if index is not None:
            return index
    index = build_index()
    save_index(index)
    return index


def tier1_vocab_match(text: str, index: dict) -> dict[str, dict]:
    """Tier 1: Vocabulary matching. Scan text for DreamNode titles.
    Returns {uuid: {title, type, path, score, source, mentions}}
    """
    text_lower = text.lower()
    results: dict[str, dict] = {}

    for phrase in index["vocab_phrases"]:
        # Check if phrase appears in text (word-boundary aware for short phrases)
        if len(phrase) <= 3:
            # Short phrases need word boundaries to avoid false positives
            pattern = r'\b' + re.escape(phrase) + r'\b'
            matches = re.findall(pattern, text_lower)
        else:
            # Longer phrases: simple substring count
            matches = []
            start = 0
            while True:
                idx = text_lower.find(phrase, start)
                if idx == -1:
                    break
                matches.append(phrase)
                start = idx + 1

        if not matches:
            continue

        count = len(matches)
        for entry in index["vocab"][phrase]:
            uid = entry["uuid"]
            if uid in results:
                results[uid]["mentions"] += count
            else:
                results[uid] = {
                    "uuid": uid,
                    "title": entry["title"],
                    "type": entry["type"],
                    "path": entry["path"],
                    "radicle_id": entry["radicle_id"],
                    "score": 1.0,
                    "source": "vocabulary",
                    "mentions": count,
                }
    return results


def tier2_bm25(text: str, index: dict, top_k: int = 20) -> dict[str, dict]:
    """Tier 2: BM25 scoring of query text against all README documents.
    Returns {uuid: {title, type, path, score, source}}
    """
    query_tokens = _tokenize(text)
    if not query_tokens:
        return {}

    # Count query term frequencies (for potential weighting, but BM25 uses binary query)
    query_terms = set(query_tokens)

    idf = index["idf"]
    doc_tf = index["doc_tf"]
    doc_lens = index["doc_lens"]
    avgdl = index["avgdl"]
    nodes = index["nodes"]

    scores: list[float] = []
    for i in range(len(nodes)):
        score = 0.0
        tf_dict = doc_tf[i]
        dl = doc_lens[i]

        for term in query_terms:
            if term not in idf:
                continue
            tf = tf_dict.get(term, 0)
            if tf == 0:
                continue
            term_idf = idf[term]
            # BM25 formula
            numerator = tf * (BM25_K1 + 1)
            denominator = tf + BM25_K1 * (1 - BM25_B + BM25_B * dl / avgdl)
            score += term_idf * numerator / denominator

        scores.append(score)

    # Get top-k by score
    ranked = sorted(range(len(scores)), key=lambda i: scores[i], reverse=True)

    results: dict[str, dict] = {}
    for rank, i in enumerate(ranked[:top_k]):
        if scores[i] <= 0:
            break
        node = nodes[i]
        results[node["uuid"]] = {
            "uuid": node["uuid"],
            "title": node["title"],
            "type": node["type"],
            "path": node["path"],
            "radicle_id": node["radicle_id"],
            "score": round(scores[i], 3),
            "source": "bm25",
        }
    return results


def context_search(text: str, index: dict, top_k: int = 15) -> list[dict]:
    """Run Tier 1 + Tier 2, merge results, return ranked list."""
    t0 = time.time()

    # Tier 1: vocabulary match
    t1_results = tier1_vocab_match(text, index)

    # Tier 2: BM25
    t2_results = tier2_bm25(text, index, top_k=top_k * 3)

    # Merge: vocab hits get priority, BM25 fills in
    merged: dict[str, dict] = {}

    # Normalize BM25 scores to [0, 1] for merging
    max_bm25 = max((r["score"] for r in t2_results.values()), default=1.0)
    if max_bm25 <= 0:
        max_bm25 = 1.0

    for uid, entry in t2_results.items():
        merged[uid] = {
            **entry,
            "bm25_score": entry["score"],
            "bm25_norm": round(entry["score"] / max_bm25, 3),
            "vocab_hit": False,
            "mentions": 0,
        }

    for uid, entry in t1_results.items():
        if uid in merged:
            merged[uid]["vocab_hit"] = True
            merged[uid]["mentions"] = entry["mentions"]
            merged[uid]["source"] = "both"
        else:
            merged[uid] = {
                **entry,
                "bm25_score": 0,
                "bm25_norm": 0,
                "vocab_hit": True,
            }

    # Combined score: vocab hit is a strong signal, BM25 provides ranking
    for uid, entry in merged.items():
        vocab_boost = 0.5 if entry.get("vocab_hit") else 0.0
        bm25_component = entry.get("bm25_norm", 0) * 0.5
        entry["combined_score"] = round(vocab_boost + bm25_component, 3)

    # Sort by combined score, then by mentions
    ranked = sorted(
        merged.values(),
        key=lambda x: (x["combined_score"], x.get("mentions", 0)),
        reverse=True,
    )[:top_k]

    elapsed_ms = round((time.time() - t0) * 1000, 1)

    # Clean up output
    output = []
    for entry in ranked:
        output.append({
            "uuid": entry["uuid"],
            "title": entry["title"],
            "type": entry["type"],
            "path": entry["path"],
            "radicle_id": entry.get("radicle_id", ""),
            "score": entry["combined_score"],
            "bm25": entry.get("bm25_score", 0),
            "vocab_hit": entry.get("vocab_hit", False),
            "mentions": entry.get("mentions", 0),
            "source": entry.get("source", ""),
        })

    return output


def run_context(args: argparse.Namespace) -> None:
    """CLI entry point for context search."""
    # Load or build index
    index = ensure_index(force=getattr(args, "rebuild", False))

    # Get input text
    input_text = args.input
    if os.path.isfile(input_text):
        input_text = Path(input_text).read_text(errors="replace")

    top_k = getattr(args, "top", 15)

    t0 = time.time()
    results = context_search(input_text, index, top_k=top_k)
    elapsed = time.time() - t0

    if getattr(args, "json_output", False):
        print(json.dumps({
            "results": results,
            "stats": {
                "elapsed_ms": round(elapsed * 1000, 1),
                "input_words": len(input_text.split()),
                "index_nodes": index["n_docs"],
                "results_count": len(results),
            }
        }, indent=2))
    else:
        # Human-readable output
        print(f"\n  {len(results)} results in {elapsed*1000:.0f}ms "
              f"({len(input_text.split())} words, {index['n_docs']} nodes indexed)\n")
        for i, r in enumerate(results):
            vocab_marker = " *" if r["vocab_hit"] else "  "
            mentions = f" ({r['mentions']}x)" if r["mentions"] > 0 else ""
            print(f"  {i+1:2d}.{vocab_marker} {r['score']:.3f}  "
                  f"{r['title']:40s}  bm25={r['bm25']:.1f}{mentions}")
        print()
        print("  * = vocabulary match (title found in text)")
        print()


def run_index(args: argparse.Namespace) -> None:
    """CLI entry point for index building."""
    force = getattr(args, "force", False)
    t0 = time.time()
    nodes = discover_nodes()
    index = build_index(nodes)
    save_index(index)
    elapsed = time.time() - t0
    print(f"Indexed {index['n_docs']} DreamNodes in {elapsed*1000:.0f}ms")
    print(f"Vocabulary: {len(index['vocab'])} phrases")
    print(f"BM25 terms: {len(index['idf'])} unique terms")
    print(f"Saved to: {INDEX_FILE}")


# ============================================================
# Server code (unchanged from original)
# ============================================================

def build_injected_index(html: str, models: list[str] | None = None) -> str:
    """Patch the AI bridge URL and inject model selector."""
    # Replace getAIBridgeWsUrl to return ws://<current host>/ws
    html = html.replace(
        "function getAIBridgeWsUrl() {\n"
        "  // When served by server.py, the InterBrain is on the same machine\n"
        "  // Use the page's hostname (works for both localhost and Tailscale IP)\n"
        "  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';\n"
        "  const host = window.location.hostname || 'localhost';\n"
        "  return `${wsProtocol}//${host}:${AI_BRIDGE_PORT}`;\n"
        "}",
        "function getAIBridgeWsUrl() {\n"
        "  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';\n"
        "  return `${wsProtocol}//${window.location.host}/ws`;\n"
        "}",
        1,
    )

    # Patch sendWsBridgeRequest to include selected model
    html = html.replace(
        "  aiBridgeWs.send(JSON.stringify({\n"
        "    type: 'ai-inference-stream-request',\n"
        "    requestId: currentRequestId,\n"
        "    messages,\n"
        "    complexity: 'standard'\n"
        "  }));",
        "  aiBridgeWs.send(JSON.stringify({\n"
        "    type: 'ai-inference-stream-request',\n"
        "    requestId: currentRequestId,\n"
        "    messages,\n"
        "    complexity: 'standard',\n"
        "    options: { model: document.getElementById('auryn-model-select')?.value || '' }\n"
        "  }));",
        1,
    )

    # Inject model selector dropdown into the existing #top-toolbar (before reload btn)
    model_options = models or ["qwen3:32b"]
    # Determine which model to pre-select: prefer claude-sonnet, else first in list
    default_sel = next(
        (m for m in model_options if "claude-sonnet" in m),
        model_options[0] if model_options else "",
    )
    opts_html = "".join(
        f'<option value="{m}"{" selected" if m == default_sel else ""}>{m}</option>'
        for m in model_options
    )
    select_el = (
        f'<select id="auryn-model-select" style="background:#1a1a1a;color:#c4a54a;'
        f'border:1px solid #333;border-radius:4px;padding:4px 6px;'
        f'font:12px -apple-system,sans-serif;min-height:30px;cursor:pointer">'
        f'{opts_html}</select>'
    )
    html = html.replace(
        '<div id="top-toolbar">\n',
        f'<div id="top-toolbar">\n{select_el}\n',
        1,
    )

    # Inject system prompt from SYSTEM_PROMPT.md
    sys_prompt_path = AURYN_DIR / "SYSTEM_PROMPT.md"
    if sys_prompt_path.exists():
        sys_prompt = sys_prompt_path.read_text(encoding="utf-8").strip()
        # Escape for JS template literal: backticks, dollar signs, backslashes
        escaped = sys_prompt.replace("\\", "\\\\").replace("`", "\\`").replace("${", "\\${")
        # Replace the hardcoded SYSTEM_PROMPT const
        import re
        html = re.sub(
            r"const SYSTEM_PROMPT = `.*?`;",
            f"const SYSTEM_PROMPT = `{escaped}`;",
            html,
            count=1,
            flags=re.DOTALL,
        )

    # Polyfill crypto.randomUUID for non-secure contexts (HTTP on mobile Safari)
    # + add global error handler to surface errors in the UI (no console on mobile)
    polyfill = (
        '<script>'
        'if(!crypto.randomUUID)crypto.randomUUID=function(){'
        'return([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g,function(c){'
        'return(c^crypto.getRandomValues(new Uint8Array(1))[0]&15>>c/4).toString(16)'
        '})};'
        'window.addEventListener("error",function(e){'
        'var d=document.createElement("div");'
        'd.style.cssText="position:fixed;top:0;left:0;right:0;background:#800;color:#fff;'
        'padding:8px;font:12px monospace;z-index:99999;white-space:pre-wrap";'
        'd.textContent="JS Error: "+e.message+" @ line "+e.lineno;'
        'document.body?document.body.appendChild(d):document.addEventListener("DOMContentLoaded",'
        'function(){document.body.appendChild(d)});'
        '});'
        '</script>\n'
    )
    html = html.replace("<head>", "<head>\n" + polyfill, 1)

    return html


# ============================================================
# Inference WebSocket (/ws)
# ============================================================

async def ws_inference(request: web.Request) -> web.WebSocketResponse:
    ws = web.WebSocketResponse(heartbeat=10.0)  # ping every 10s, kill after 30s no pong
    await ws.prepare(request)

    ollama_url = request.app["ollama_url"]
    default_model = request.app["default_model"]
    active_tasks: dict[str, asyncio.Task] = {}

    await ws.send_json({"type": "ai-bridge-ready", "version": "2"})

    async for msg in ws:
        if msg.type == aiohttp.WSMsgType.TEXT:
            try:
                data = json.loads(msg.data)
            except json.JSONDecodeError:
                continue

            if data.get("type") == "ai-bridge-probe":
                await ws.send_json({"type": "ai-bridge-ready", "version": "2"})

            elif data.get("type") == "ai-inference-stream-request":
                request_id = data.get("requestId", str(uuid.uuid4()))
                messages = data.get("messages", [])
                options = data.get("options", {})
                model = options.get("model") or default_model

                if model.startswith("claude-"):
                    coro = _stream_claude(
                        ws, request_id, messages, model,
                        request.app.get("claude_api_key", ""),
                    )
                else:
                    coro = _stream_ollama(ws, request_id, messages, model, ollama_url)

                task = asyncio.create_task(coro)
                active_tasks[request_id] = task
                task.add_done_callback(lambda t, rid=request_id: active_tasks.pop(rid, None))

            elif data.get("type") in ("ai-inference-stream-cancel", "tool-call-cancel"):
                rid = data.get("requestId")
                task = active_tasks.pop(rid, None)
                if task:
                    task.cancel()

        elif msg.type in (aiohttp.WSMsgType.ERROR, aiohttp.WSMsgType.CLOSE):
            break

    for task in active_tasks.values():
        task.cancel()
    active_tasks.clear()
    return ws


async def _stream_ollama(
    ws: web.WebSocketResponse,
    request_id: str,
    messages: list[dict],
    model: str,
    ollama_url: str,
) -> None:
    """Stream inference from Ollama and relay chunks over WebSocket."""
    url = f"{ollama_url}/api/chat"
    payload = {"model": model, "messages": messages, "stream": True}
    partial_content = ""

    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(url, json=payload) as resp:
                if resp.status != 200:
                    error_text = await resp.text()
                    await ws.send_json({
                        "type": "ai-inference-stream-error",
                        "requestId": request_id,
                        "error": f"Ollama error ({resp.status}): {error_text}",
                    })
                    return

                prompt_tokens = 0
                completion_tokens = 0

                async for line in resp.content:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        chunk_data = json.loads(line)
                    except json.JSONDecodeError:
                        continue

                    if chunk_data.get("done"):
                        prompt_tokens = chunk_data.get("prompt_eval_count", 0)
                        completion_tokens = chunk_data.get("eval_count", 0)
                        break

                    token = chunk_data.get("message", {}).get("content", "")
                    if token:
                        partial_content += token
                        await ws.send_json({
                            "type": "ai-inference-stream-chunk",
                            "requestId": request_id,
                            "chunk": token,
                        })

                await ws.send_json({
                    "type": "ai-inference-stream-done",
                    "requestId": request_id,
                    "provider": "ollama",
                    "model": model,
                    "usage": {
                        "promptTokens": prompt_tokens,
                        "completionTokens": completion_tokens,
                    },
                })

    except asyncio.CancelledError:
        pass
    except Exception as e:
        try:
            await ws.send_json({
                "type": "ai-inference-stream-error",
                "requestId": request_id,
                "error": str(e),
                "partialContent": partial_content or None,
            })
        except ConnectionResetError:
            pass


# ============================================================
# Tool definitions for Claude's native tool calling
# ============================================================

AURYN_TOOLS = [
    {
        "name": "bash",
        "description": (
            "Execute a bash command. Use this for all operations: auryn CLI commands, "
            "Claude Code delegation via `auryn cc`, and any other shell commands needed. "
            "Commands run in the AURYN directory by default.\n\n"
            "Available auryn subcommands:\n"
            "- auryn search <query> [--top N] [--json] — Search DreamNodes by keyword/concept\n"
            "- auryn read <id|title|folder> [--deep] — Load a DreamNode into context as a petal\n"
            "- auryn write <id|title|folder> --old <text> --new <text> [--message <msg>] — Edit a DreamNode README\n"
            "- auryn create <title> [--readme <content>] — Create a new DreamNode\n"
            "- auryn pop-out <parent> --title <name> --readme <content> --old <text> --new <text> — Pop out to sovereign\n"
            "- auryn reveal <file_path> — Show a file to the user in the DreamSpace viewer\n"
            "- auryn garden-state [--refresh] — Scan vault health and write report\n"
            "- auryn publish <id|title|folder> — Publish DreamNode to Radicle\n"
            "- auryn cc <id> <prompt> [--budget <usd>] — Delegate task to Claude Code in a DreamNode\n"
            "- auryn clip <id> --segments <json> --source <file> — Create a songline clip\n\n"
            "You can chain commands with && or pipe with |. For complex file operations, "
            "use auryn cc to delegate to Claude Code."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "The bash command to execute.",
                },
            },
            "required": ["command"],
        },
    },
]


# ============================================================
# Bash command parser — extract auryn subcommands from bash strings
# ============================================================

# UUID pattern for DreamNode IDs
_UUID_RE = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', re.IGNORECASE)

# Cache for node lookups (refreshed per request)
_node_cache: dict[str, dict] | None = None
_node_cache_time: float = 0


def _get_node_cache() -> dict[str, dict]:
    """Get or refresh the node cache (keyed by UUID)."""
    global _node_cache, _node_cache_time
    now = time.time()
    if _node_cache is None or (now - _node_cache_time) > 30:  # refresh every 30s
        nodes = discover_nodes()
        _node_cache = {n["uuid"]: n for n in nodes if n["uuid"]}
        _node_cache_time = now
    return _node_cache


def _parse_auryn_commands(command: str) -> dict:
    """Parse a bash command string to extract auryn subcommands and metadata.

    Splits on && (sequential) and | (pipe), respecting quotes.
    For each segment, checks if it starts with 'auryn ' and extracts
    subcommand name, involved DreamNode IDs, and the full segment text.
    """
    # Split on && and | while respecting quotes
    segments = []
    current = []
    in_single = False
    in_double = False
    i = 0
    chars = command

    while i < len(chars):
        c = chars[i]
        if c == "'" and not in_double:
            in_single = not in_single
            current.append(c)
        elif c == '"' and not in_single:
            in_double = not in_double
            current.append(c)
        elif not in_single and not in_double:
            if c == '&' and i + 1 < len(chars) and chars[i + 1] == '&':
                seg_text = ''.join(current).strip()
                if seg_text:
                    connector = "sequential" if segments else None
                    segments.append({"raw": seg_text, "connector": connector})
                current = []
                i += 2
                continue
            elif c == '|' and (i + 1 >= len(chars) or chars[i + 1] != '|'):
                seg_text = ''.join(current).strip()
                if seg_text:
                    connector = "pipe" if segments else None
                    segments.append({"raw": seg_text, "connector": connector})
                current = []
                i += 1
                continue
            else:
                current.append(c)
        else:
            current.append(c)
        i += 1

    # Last segment
    seg_text = ''.join(current).strip()
    if seg_text:
        connector = None
        if segments:
            # Determine connector from what came before
            # We already set connectors above, so for the last segment
            # we need to figure out what separated it
            # The connector is set on the NEXT segment, so we check the gap
            pass
        segments.append({"raw": seg_text, "connector": None})

    # Fix connectors: the connector describes what came BEFORE this segment
    # Re-parse to get connectors right
    result_segments = []
    parts = []
    current_text = []
    connectors_list = []
    in_single = False
    in_double = False
    i = 0

    while i < len(chars):
        c = chars[i]
        if c == "'" and not in_double:
            in_single = not in_single
            current_text.append(c)
        elif c == '"' and not in_single:
            in_double = not in_double
            current_text.append(c)
        elif not in_single and not in_double:
            if c == '&' and i + 1 < len(chars) and chars[i + 1] == '&':
                parts.append(''.join(current_text).strip())
                connectors_list.append("sequential")
                current_text = []
                i += 2
                continue
            elif c == '|' and (i + 1 >= len(chars) or chars[i + 1] != '|'):
                parts.append(''.join(current_text).strip())
                connectors_list.append("pipe")
                current_text = []
                i += 1
                continue
            else:
                current_text.append(c)
        else:
            current_text.append(c)
        i += 1

    last_part = ''.join(current_text).strip()
    if last_part:
        parts.append(last_part)

    # Build result segments
    node_cache = _get_node_cache()

    for idx, raw in enumerate(parts):
        if not raw:
            continue
        connector = connectors_list[idx - 1] if idx > 0 and idx - 1 < len(connectors_list) else None
        stripped = raw.strip()

        # Check if this is an auryn command
        is_auryn = stripped.startswith("auryn ") or stripped == "auryn"
        subcommand = None
        ids = []
        id_details = []

        if is_auryn:
            # Extract subcommand (second word)
            auryn_parts = stripped.split(None, 2)
            if len(auryn_parts) >= 2:
                subcommand = auryn_parts[1]

            # Extract UUIDs
            found_ids = _UUID_RE.findall(stripped)
            for uid in found_ids:
                uid_lower = uid.lower()
                ids.append(uid_lower)
                node = node_cache.get(uid_lower)
                if node:
                    # Find dreamTalk media path
                    udd_path = Path(node["path"]) / ".udd"
                    dreamtalk = ""
                    try:
                        udd_data = json.loads(udd_path.read_text())
                        dreamtalk = udd_data.get("dreamTalk", "")
                    except (OSError, json.JSONDecodeError):
                        pass
                    id_details.append({
                        "id": uid_lower,
                        "title": node["title"],
                        "folder": node["folder"],
                        "dreamTalk": dreamtalk,
                    })
                else:
                    id_details.append({"id": uid_lower, "title": "", "folder": "", "dreamTalk": ""})

            # Fallback: if no UUIDs found, try title/folder matching
            # for commands like `auryn read "Spring Launch"`
            if not found_ids and subcommand and len(auryn_parts) >= 3:
                identifier = auryn_parts[2].strip().strip('"').strip("'")
                # Remove any trailing flags
                identifier = re.split(r'\s+--', identifier)[0].strip()
                if identifier:
                    matched_node = _find_node(identifier)
                    if matched_node and matched_node["uuid"]:
                        uid = matched_node["uuid"]
                        ids.append(uid)
                        udd_path = Path(matched_node["path"]) / ".udd"
                        dreamtalk = ""
                        try:
                            udd_data = json.loads(udd_path.read_text())
                            dreamtalk = udd_data.get("dreamTalk", "")
                        except (OSError, json.JSONDecodeError):
                            pass
                        id_details.append({
                            "id": uid,
                            "title": matched_node["title"],
                            "folder": matched_node["folder"],
                            "dreamTalk": dreamtalk,
                        })

        result_segments.append({
            "type": "auryn" if is_auryn else "other",
            "subcommand": subcommand,
            "ids": ids,
            "id_details": id_details,
            "raw": raw,
            "connector": connector,
        })

    return {
        "segments": result_segments,
        "is_compound": len(result_segments) > 1,
    }


# ============================================================
# Bash tool executor
# ============================================================


def _parse_read_output_for_petal(output: str) -> dict | None:
    """Parse auryn read output to extract node metadata for petal-add events."""
    if not output:
        return None
    try:
        # The read output format:
        # === Title ===
        # ID:     uuid
        # Type:   type
        # Folder: folder
        # Path:   path
        title_match = re.search(r'^=== (.+?) ===$', output, re.MULTILINE)
        id_match = re.search(r'^ID:\s+(.+)$', output, re.MULTILINE)
        type_match = re.search(r'^Type:\s+(.+)$', output, re.MULTILINE)
        path_match = re.search(r'^Path:\s+(.+)$', output, re.MULTILINE)

        if title_match and id_match:
            return {
                "id": id_match.group(1).strip(),
                "title": title_match.group(1).strip(),
                "type": type_match.group(1).strip() if type_match else "dream",
                "path": path_match.group(1).strip() if path_match else "",
            }
    except Exception:
        pass
    return None


async def _execute_bash(
    command: str,
    ws: "web.WebSocketResponse | None" = None,
    request_id: str = "",
) -> str:
    """Execute a bash command and return the result.

    Handles auryn cc specially by routing through run_claude_code_streaming.
    All other commands run via asyncio.create_subprocess_shell.
    """
    global _last_cc_inject_index
    command = command.strip()

    # Check for auryn cc — route through Claude Code streaming
    # Match: auryn cc <id> <prompt>, auryn cc <id> "<prompt>"
    cc_match = re.match(r'^auryn\s+cc\s+(.+)$', command, re.DOTALL)
    if cc_match:
        cc_args_str = cc_match.group(1).strip()

        # Parse optional flags
        cwd = None
        budget = 0.50
        model = "sonnet"

        # Simple flag extraction
        remaining = cc_args_str

        budget_match = re.search(r'--budget\s+([0-9.]+)', remaining)
        if budget_match:
            budget = float(budget_match.group(1))
            remaining = remaining[:budget_match.start()] + remaining[budget_match.end():]

        model_match = re.search(r'--model\s+(\S+)', remaining)
        if model_match:
            model = model_match.group(1)
            remaining = remaining[:model_match.start()] + remaining[model_match.end():]

        remaining = remaining.strip()

        # Extract DreamNode ID as first argument (before the prompt)
        # ID can be a UUID or a quoted/unquoted title/folder
        id_match = re.match(
            r'([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s+(.+)',
            remaining, re.IGNORECASE | re.DOTALL)
        if id_match:
            node_id = id_match.group(1)
            prompt = id_match.group(2).strip().strip('"').strip("'")
            node = _find_node(node_id)
            if node:
                cwd = node["path"]
        else:
            # No ID found — treat entire remaining as prompt, default to AURYN_DIR
            prompt = remaining.strip().strip('"').strip("'")

        # Use existing Claude Code execution with streaming
        try:
            is_auryn_local = not cwd or not Path(cwd).is_dir()
            effective_cwd = str(AURYN_DIR) if is_auryn_local else cwd

            # Delta injection for AURYN-local sessions
            if is_auryn_local:
                all_messages = _load_chat_messages()
                if all_messages:
                    if _last_cc_inject_index == 0:
                        history = _format_messages_as_text(all_messages)
                        label = "AURYN CHAT HISTORY"
                    else:
                        delta = all_messages[_last_cc_inject_index:]
                        if delta:
                            history = _format_messages_as_text(delta)
                            label = "AURYN CHAT UPDATE (since last Claude Code call)"
                        else:
                            history = ""
                            label = ""

                    _last_cc_inject_index = len(all_messages)

                    if history:
                        prompt = (
                            f"=== {label} ===\n"
                            + history
                            + f"\n=== END {label} ===\n\n"
                            "Your directive:\n"
                            + prompt
                        )

            final_result = ""
            is_error = False
            cost = 0.0
            subtype = ""

            async for event in run_claude_code_streaming(
                prompt=prompt,
                model=model,
                max_budget=budget,
                cwd=effective_cwd,
                allowed_tools="Bash Read Edit Write Grep Glob",
            ):
                etype = event.get("type", "")

                # Stream activity events to frontend
                if ws and request_id:
                    try:
                        await ws.send_json({
                            "type": "cc-activity",
                            "requestId": request_id,
                            "event": event,
                        })
                    except (ConnectionResetError, ConnectionError):
                        pass

                if etype == "result":
                    final_result = event.get("result", "")
                    is_error = event.get("is_error", False)
                    subtype = event.get("subtype", "")
                    cost = event.get("total_cost_usd", 0)

            if subtype == "error_max_budget_usd":
                return f"**Claude Code** hit session budget limit (${cost:.2f} accumulated)."

            prefix = "**Claude Code error:**\n" if is_error else f"**Claude Code result** (${cost:.4f}):\n"
            return prefix + (final_result or "(no output)")
        except Exception as e:
            return f"Claude Code execution error: {e}"

    # Rewrite bare `auryn` commands to `uv run auryn.py`
    # so Claude can use `auryn search ...` naturally
    command = re.sub(r'\bauryn\b', f'uv run {AURYN_DIR}/auryn.py', command)

    # For all other commands: run via subprocess
    try:
        proc = await asyncio.create_subprocess_shell(
            command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(AURYN_DIR),
        )

        # Register so it can be killed on cancel
        task_id = id(asyncio.current_task())
        _active_cc_procs[task_id] = proc

        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=120)
        finally:
            _active_cc_procs.pop(task_id, None)

        result_parts = []
        if stdout:
            result_parts.append(stdout.decode("utf-8", errors="replace"))
        if stderr:
            result_parts.append("STDERR:\n" + stderr.decode("utf-8", errors="replace"))
        if proc.returncode != 0:
            result_parts.append(f"\n(exit code: {proc.returncode})")

        return "\n".join(result_parts) if result_parts else "(no output)"

    except asyncio.TimeoutError:
        return "Command timed out after 120 seconds."
    except Exception as e:
        return f"Command execution error: {e}"


def _sanitize_to_pascal_case(title: str) -> str:
    """Convert a title to PascalCase folder name (e.g. 'Zero Point Energy' -> 'ZeroPointEnergy')."""
    words = re.split(r"[\s\-_]+", title.strip())
    return "".join(w.capitalize() for w in words if w)


def _execute_create_dreamnode(title: str, readme_content: str = "", node_type: str = "dream") -> str:
    """Create a new DreamNode with git init, .udd metadata, and initial README."""
    try:
        folder_name = _sanitize_to_pascal_case(title)
        node_path = VAULT_DIR / folder_name

        if node_path.exists():
            return json.dumps({"error": f"Directory already exists: {node_path}"})

        node_id = str(uuid.uuid4())
        node_path.mkdir(parents=True)

        # Write .udd
        udd = {"id": node_id, "title": title, "type": node_type, "dreamTalk": ""}
        (node_path / ".udd").write_text(json.dumps(udd, indent=2))

        # Write README
        if not readme_content:
            readme_content = f"# {title}\n"
        (node_path / "README.md").write_text(readme_content, encoding="utf-8")

        # Git init and initial commit
        subprocess.run(["git", "init"], cwd=node_path, capture_output=True)
        subprocess.run(["git", "add", "."], cwd=node_path, capture_output=True)
        subprocess.run(
            ["git", "commit", "-m", f"Plant seed: {title}"],
            cwd=node_path, capture_output=True,
        )

        # Try Radicle init (non-fatal)
        rad_id = ""
        rad_result = subprocess.run(
            ["rad", "init", "--name", title, "--default-branch", "main",
             "--description", f"DreamNode: {title}", "--no-confirm"],
            cwd=node_path, capture_output=True, text=True,
        )
        if rad_result.returncode == 0:
            # Extract bare key from rad output
            for line in rad_result.stdout.splitlines():
                if line.strip().startswith("rad:"):
                    rad_id = line.strip().replace("rad:", "")
                    break
            if rad_id:
                udd["id"] = rad_id
                (node_path / ".udd").write_text(json.dumps(udd, indent=2))
                subprocess.run(["git", "add", ".udd"], cwd=node_path, capture_output=True)
                subprocess.run(
                    ["git", "commit", "-m", "Update id with Radicle key"],
                    cwd=node_path, capture_output=True,
                )

        return json.dumps({
            "id": udd["id"],
            "title": title,
            "path": str(node_path),
            "folder": folder_name,
            "type": node_type,
            "radicle": bool(rad_id),
        })
    except Exception as e:
        return json.dumps({"error": str(e)})


def _execute_audit_garden(
    keyword: str = "",
    limit: int = 20,
    include_shallow: bool = False,
    check_metadata: bool = False,
) -> str:
    """Scan vault for DreamNodes needing attention."""
    try:
        BOILERPLATE_LINES = 2  # READMEs with <= this many non-blank lines are boilerplate
        SHALLOW_LINES = 5      # READMEs with <= this many are shallow

        nodes_needing_attention = []
        total_nodes = 0
        total_boilerplate = 0
        total_shallow = 0
        total_metadata_issues = 0

        for udd_path in sorted(VAULT_DIR.rglob("*.udd")):
            rel = udd_path.relative_to(VAULT_DIR)
            # Skip nested (submodule) DreamNodes — only check top-level
            if len(rel.parts) > 2:
                continue

            dn_dir = udd_path.parent
            total_nodes += 1

            # Keyword filter
            folder_name = dn_dir.name
            if keyword:
                kw_lower = keyword.lower()
                if kw_lower not in folder_name.lower():
                    # Also check title from .udd
                    try:
                        udd = json.loads(udd_path.read_text())
                        title = udd.get("title", "")
                    except Exception:
                        title = ""
                    if kw_lower not in title.lower():
                        continue

            readme_path = dn_dir / "README.md"
            issues = []

            # Check README state
            if not readme_path.exists():
                issues.append("missing_readme")
                total_boilerplate += 1
            else:
                content = readme_path.read_text(encoding="utf-8")
                meaningful_lines = [
                    l for l in content.splitlines()
                    if l.strip() and not l.strip().startswith("#")
                ]
                if len(meaningful_lines) <= BOILERPLATE_LINES:
                    issues.append("boilerplate_readme")
                    total_boilerplate += 1
                elif include_shallow and len(meaningful_lines) <= SHALLOW_LINES:
                    issues.append("shallow_readme")
                    total_shallow += 1

            # Check metadata if requested
            if check_metadata:
                try:
                    udd = json.loads(udd_path.read_text())
                except (json.JSONDecodeError, OSError):
                    issues.append("invalid_udd_json")
                    total_metadata_issues += 1
                    udd = {}

                if udd:
                    if not udd.get("id") and not udd.get("uuid"):
                        issues.append("missing_id")
                        total_metadata_issues += 1
                    if not udd.get("title"):
                        issues.append("missing_title")
                        total_metadata_issues += 1
                    if not udd.get("type"):
                        issues.append("missing_type")
                        total_metadata_issues += 1

            if issues:
                # Read title from .udd
                try:
                    udd_data = json.loads(udd_path.read_text())
                    title = udd_data.get("title", folder_name)
                except Exception:
                    title = folder_name

                nodes_needing_attention.append({
                    "title": title,
                    "folder": folder_name,
                    "path": str(dn_dir),
                    "issues": issues,
                })

            if len(nodes_needing_attention) >= limit:
                break

        return json.dumps({
            "total_nodes": total_nodes,
            "total_boilerplate": total_boilerplate,
            "total_shallow": total_shallow,
            "total_metadata_issues": total_metadata_issues,
            "returned": len(nodes_needing_attention),
            "limit": limit,
            "nodes": nodes_needing_attention,
        })
    except Exception as e:
        return json.dumps({"error": str(e)})


def _execute_read_dreamnode(identifier: str) -> str:
    """Read a DreamNode by title, folder name, or absolute path."""
    try:
        dn_path = None

        # Try as absolute path first
        candidate = Path(identifier)
        if candidate.is_absolute() and candidate.exists() and (candidate / ".udd").exists():
            dn_path = candidate
        else:
            # Search vault for matching folder or title
            identifier_lower = identifier.lower()
            best_match = None

            for udd_path in VAULT_DIR.rglob("*.udd"):
                rel = udd_path.relative_to(VAULT_DIR)
                if len(rel.parts) > 2:
                    continue

                dn_dir = udd_path.parent
                folder_name = dn_dir.name

                # Exact folder match
                if folder_name.lower() == identifier_lower:
                    dn_path = dn_dir
                    break

                # Title match from .udd
                try:
                    udd = json.loads(udd_path.read_text())
                    title = udd.get("title", "")
                    if title.lower() == identifier_lower:
                        dn_path = dn_dir
                        break
                    # Fuzzy: identifier is substring of title or folder
                    if identifier_lower in title.lower() or identifier_lower in folder_name.lower():
                        if best_match is None:
                            best_match = dn_dir
                except Exception:
                    pass

            if dn_path is None:
                dn_path = best_match

        if dn_path is None:
            return json.dumps({"error": f"No DreamNode found matching: {identifier}"})

        # Read .udd
        udd_path = dn_path / ".udd"
        udd_data = {}
        if udd_path.exists():
            try:
                udd_data = json.loads(udd_path.read_text())
            except Exception:
                udd_data = {"error": "invalid JSON in .udd"}

        # Read README
        readme_path = dn_path / "README.md"
        readme_content = ""
        if readme_path.exists():
            readme_content = readme_path.read_text(encoding="utf-8")
            if len(readme_content) > 5000:
                readme_content = readme_content[:5000] + "\n\n[...truncated at 5000 chars...]"
        else:
            readme_content = "(no README.md)"

        # List files (non-hidden, top-level only)
        files = []
        for f in sorted(dn_path.iterdir()):
            if f.name.startswith("."):
                continue
            if f.is_dir():
                files.append(f"{f.name}/")
            else:
                files.append(f.name)

        return json.dumps({
            "title": udd_data.get("title", dn_path.name),
            "path": str(dn_path),
            "folder": dn_path.name,
            "metadata": udd_data,
            "readme": readme_content,
            "files": files,
        })
    except Exception as e:
        return json.dumps({"error": str(e)})


def _execute_reveal_file(file_path: str) -> str:
    """Validate a file path and return metadata for the frontend to open it."""
    try:
        fp = Path(file_path).resolve()
        if not str(fp).startswith(str(VAULT_DIR)):
            return json.dumps({"error": f"Path {fp} is outside the vault."})
        if not fp.exists():
            return json.dumps({"error": f"File not found: {fp}"})
        if fp.is_dir():
            return json.dumps({"error": f"Path is a directory, not a file: {fp}"})

        # Find which DreamNode contains this file
        rel = fp.relative_to(VAULT_DIR)
        dreamnode_folder = rel.parts[0] if rel.parts else ""
        dreamnode_id = ""
        dreamnode_title = ""
        dn_path = VAULT_DIR / dreamnode_folder
        udd_path = dn_path / ".udd"
        if udd_path.exists():
            try:
                udd = json.loads(udd_path.read_text())
                dreamnode_id = udd.get("uuid", "")
                dreamnode_title = udd.get("title", dreamnode_folder)
            except (json.JSONDecodeError, OSError):
                pass

        # Build the URL path for serving this file
        rel_path = str(rel)
        suffix = fp.suffix.lower()
        mime_map = {
            ".pdf": "application/pdf",
            ".html": "text/html", ".htm": "text/html",
            ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
            ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
            ".mp4": "video/mp4", ".webm": "video/webm",
            ".txt": "text/plain", ".md": "text/markdown",
            ".json": "application/json", ".csv": "text/csv",
            ".py": "text/plain", ".js": "text/plain", ".ts": "text/plain",
        }
        content_type = mime_map.get(suffix, "application/octet-stream")

        return json.dumps({
            "action": "reveal_file",
            "filePath": str(fp),
            "relPath": rel_path,
            "contentType": content_type,
            "dreamnodeId": dreamnode_id,
            "dreamnodeTitle": dreamnode_title,
            "dreamnodeFolder": dreamnode_folder,
        })
    except Exception as e:
        return json.dumps({"error": str(e)})


def _execute_edit_readme(
    dreamnode_path: str, old_text: str, new_text: str, commit_message: str
) -> str:
    """Edit a DreamNode README.md and auto-commit the change."""
    try:
        dn_path = Path(dreamnode_path).resolve()
        readme_path = dn_path / "README.md"

        # Validate the path is inside the vault
        if not str(dn_path).startswith(str(VAULT_DIR)):
            return f"Error: path {dn_path} is outside the vault."
        if not readme_path.exists():
            return f"Error: no README.md found at {readme_path}"

        content = readme_path.read_text(encoding="utf-8")

        if old_text not in content:
            return (
                "Error: old_text not found in README.md. "
                "Make sure it matches exactly (whitespace-sensitive). "
                f"README length: {len(content)} chars."
            )

        if old_text == new_text:
            return "Error: old_text and new_text are identical. No change needed."

        # Count occurrences to avoid ambiguous edits
        count = content.count(old_text)
        if count > 1:
            return (
                f"Error: old_text appears {count} times in README.md. "
                "Provide more surrounding context to make the match unique."
            )

        # Apply the edit
        new_content = content.replace(old_text, new_text, 1)
        readme_path.write_text(new_content, encoding="utf-8")

        # Auto-commit
        import subprocess

        subprocess.run(
            ["git", "add", "README.md"],
            cwd=str(dn_path),
            capture_output=True,
        )
        result = subprocess.run(
            ["git", "commit", "-m", commit_message],
            cwd=str(dn_path),
            capture_output=True,
            text=True,
        )

        if result.returncode != 0:
            return f"Edit applied but commit failed: {result.stderr.strip()}"

        return f"README.md updated and committed: {commit_message}"

    except Exception as e:
        return f"Error editing README: {e}"


def _execute_search_dreamnodes(query: str, top_k: int = 8, include_readme: bool = False) -> str:
    """Execute search_dreamnodes tool synchronously."""
    try:
        index = load_index()
        if index is None:
            return "No search index available. Run `auryn.py index` to build it."

        top_k = min(max(1, top_k), 20)
        results = context_search(query, index, top_k=top_k)

        if not results:
            return f"No DreamNodes found for query: {query!r}"

        lines = [f"Found {len(results)} DreamNode(s) for {query!r}:\n"]
        for r in results:
            lines.append(f"**{r['title']}** (score: {r['score']:.3f})")
            lines.append(f"  Path: {r['path']}")
            if r.get("vocab_hit"):
                lines.append(f"  Vocab match: yes ({r.get('mentions', 0)} mention(s))")
            if include_readme:
                readme = Path(r["path"]) / "README.md"
                if readme.exists():
                    content = readme.read_text(encoding="utf-8")
                    # Truncate very long READMEs
                    if len(content) > 3000:
                        content = content[:3000] + "\n\n[...truncated...]"
                    lines.append(f"\n  README:\n{content}")
            lines.append("")

        return "\n".join(lines)
    except Exception as e:
        return f"Search error: {e}"


def _load_chat_history_text(thread_id: str = "current") -> str:
    """Read chat history from disk and format it as a labeled block for Claude Code."""
    chat_file = CHATS_DIR / f"{thread_id}.json"
    if not chat_file.exists():
        return ""
    try:
        data = json.loads(chat_file.read_text())
        messages = data.get("messages", [])
        if not messages:
            return ""
        lines = []
        for m in messages:
            role = "David" if m["role"] == "user" else "AURYN"
            lines.append(f"{role}: {m['content']}")
        return "\n\n".join(lines)
    except Exception:
        return ""


def _load_chat_messages(thread_id: str = "current") -> list[dict]:
    """Read chat messages list from disk."""
    chat_file = CHATS_DIR / f"{thread_id}.json"
    if not chat_file.exists():
        return []
    try:
        data = json.loads(chat_file.read_text())
        return data.get("messages", [])
    except Exception:
        return []


# Track last-injected message index for delta injection per AURYN chat session
_last_cc_inject_index: int = 0


def _format_messages_as_text(messages: list[dict]) -> str:
    """Format a list of chat messages as labeled text."""
    lines = []
    for m in messages:
        role = "David" if m["role"] == "user" else "AURYN"
        lines.append(f"{role}: {m['content']}")
    return "\n\n".join(lines)


async def _dispatch_tool(
    tool_name: str,
    tool_input: dict,
    ws: "web.WebSocketResponse | None" = None,
    request_id: str = "",
) -> str:
    """Dispatch a tool call and return the result as a string."""
    if tool_name == "bash":
        return await _execute_bash(
            command=tool_input.get("command", ""),
            ws=ws,
            request_id=request_id,
        )
    else:
        return f"Unknown tool: {tool_name}"


async def _stream_claude(
    ws: web.WebSocketResponse,
    request_id: str,
    messages: list[dict],
    model: str,
    api_key: str,
) -> None:
    """Stream inference from Claude API with native tool calling.

    Implements an agentic loop: Claude can call bash commands (auryn CLI,
    auryn cc for Claude Code delegation) autonomously, then streams its
    final response.
    """
    if not api_key:
        await ws.send_json({
            "type": "ai-inference-stream-error",
            "requestId": request_id,
            "error": "No Claude API key configured. Set claudeApiKey in InterBrain settings.",
        })
        return

    system_msg = None
    api_messages = []
    for m in messages:
        if m.get("role") == "system":
            system_msg = m.get("content", "")
        else:
            api_messages.append({"role": m["role"], "content": m["content"]})

    headers = {
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }

    partial_content = ""
    prompt_tokens = 0
    completion_tokens = 0
    max_tool_rounds = 5  # prevent infinite loops

    try:
        async with aiohttp.ClientSession() as session:
            for _round in range(max_tool_rounds + 1):
                payload: dict = {
                    "model": model,
                    "max_tokens": 8192,
                    "messages": api_messages,
                    "tools": AURYN_TOOLS,
                    "stream": True,
                }
                if system_msg:
                    payload["system"] = system_msg

                async with session.post(
                    "https://api.anthropic.com/v1/messages",
                    json=payload,
                    headers=headers,
                ) as resp:
                    if resp.status != 200:
                        error_text = await resp.text()
                        await ws.send_json({
                            "type": "ai-inference-stream-error",
                            "requestId": request_id,
                            "error": f"Claude API error ({resp.status}): {error_text}",
                        })
                        return

                    # Collect the full response (text + tool_use blocks)
                    content_blocks: list[dict] = []
                    current_block: dict | None = None
                    stop_reason = None

                    async for line in resp.content:
                        line = line.decode("utf-8", errors="replace").strip()
                        if not line.startswith("data: "):
                            continue
                        data_str = line[6:]
                        if data_str == "[DONE]":
                            break
                        try:
                            event = json.loads(data_str)
                        except json.JSONDecodeError:
                            continue

                        etype = event.get("type")

                        if etype == "message_start":
                            msg_usage = event.get("message", {}).get("usage", {})
                            prompt_tokens += msg_usage.get("input_tokens", 0)
                            stop_reason = event.get("message", {}).get("stop_reason")

                        elif etype == "content_block_start":
                            block = event.get("content_block", {})
                            current_block = {"type": block.get("type"), "index": event.get("index", 0)}
                            if block.get("type") == "text":
                                current_block["text"] = ""
                            elif block.get("type") == "tool_use":
                                current_block["id"] = block.get("id", "")
                                current_block["name"] = block.get("name", "")
                                current_block["input_json"] = ""

                        elif etype == "content_block_delta":
                            delta = event.get("delta", {})
                            if current_block is None:
                                continue
                            if delta.get("type") == "text_delta":
                                token = delta.get("text", "")
                                if token:
                                    current_block["text"] = current_block.get("text", "") + token
                                    partial_content += token
                                    await ws.send_json({
                                        "type": "ai-inference-stream-chunk",
                                        "requestId": request_id,
                                        "chunk": token,
                                    })
                            elif delta.get("type") == "input_json_delta":
                                current_block["input_json"] = current_block.get("input_json", "") + delta.get("partial_json", "")

                        elif etype == "content_block_stop":
                            if current_block is not None:
                                content_blocks.append(current_block)
                                current_block = None

                        elif etype == "message_delta":
                            usage = event.get("usage", {})
                            completion_tokens += usage.get("output_tokens", 0)
                            stop_reason = event.get("delta", {}).get("stop_reason") or stop_reason

                # Collect tool_use blocks from this round
                tool_use_blocks = [b for b in content_blocks if b.get("type") == "tool_use"]

                if not tool_use_blocks or stop_reason != "tool_use":
                    # No tool calls — we're done
                    break

                # Add assistant's response (with tool_use blocks) to message history
                assistant_content = []
                for b in content_blocks:
                    if b.get("type") == "text" and b.get("text"):
                        assistant_content.append({"type": "text", "text": b["text"]})
                    elif b.get("type") == "tool_use":
                        try:
                            tool_input = json.loads(b.get("input_json", "{}"))
                        except json.JSONDecodeError:
                            tool_input = {}
                        assistant_content.append({
                            "type": "tool_use",
                            "id": b["id"],
                            "name": b["name"],
                            "input": tool_input,
                        })
                api_messages.append({"role": "assistant", "content": assistant_content})

                # Execute each tool and collect results
                tool_results = []
                for b in tool_use_blocks:
                    try:
                        tool_input = json.loads(b.get("input_json", "{}"))
                    except json.JSONDecodeError:
                        tool_input = {}

                    # Notify frontend that a tool is running
                    start_msg = {
                        "type": "tool-call-start",
                        "requestId": request_id,
                        "tool_name": b["name"],
                        "tool_input": tool_input,
                    }
                    # For bash tool: parse auryn commands and include metadata
                    if b["name"] == "bash":
                        command = tool_input.get("command", "")
                        auryn_meta = _parse_auryn_commands(command)
                        start_msg["auryn_meta"] = auryn_meta
                        # Include cwd for cc commands (extract DreamNode ID)
                        cc_match = re.match(r'^auryn\s+cc\s+', command)
                        if cc_match:
                            cc_rest = command[cc_match.end():].strip()
                            cc_id_match = re.match(
                                r'([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})',
                                cc_rest, re.IGNORECASE)
                            if cc_id_match:
                                cc_node = _find_node(cc_id_match.group(1))
                                start_msg["cwd"] = cc_node["path"] if cc_node else str(AURYN_DIR)
                            else:
                                start_msg["cwd"] = str(AURYN_DIR)
                        # Mark read commands as silent (petal-only, no visible card)
                        if auryn_meta.get("segments"):
                            for seg in auryn_meta["segments"]:
                                if seg.get("subcommand") == "read":
                                    start_msg["silent"] = True
                                    break
                    await ws.send_json(start_msg)

                    tool_result = await _dispatch_tool(b["name"], tool_input, ws=ws, request_id=request_id)
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": b["id"],
                        "content": tool_result,
                    })

                    await ws.send_json({
                        "type": "tool-call-result",
                        "requestId": request_id,
                        "tool_name": b["name"],
                        "result": tool_result,
                    })

                    # Emit petal-add for auryn read commands
                    if b["name"] == "bash" and start_msg.get("silent"):
                        _emit_petal = _parse_read_output_for_petal(tool_result)
                        if _emit_petal:
                            await ws.send_json({
                                "type": "petal-add",
                                "requestId": request_id,
                                "node": _emit_petal,
                            })

                # Add tool results to message history for next round
                api_messages.append({"role": "user", "content": tool_results})

        await ws.send_json({
            "type": "ai-inference-stream-done",
            "requestId": request_id,
            "provider": "anthropic",
            "model": model,
            "usage": {
                "promptTokens": prompt_tokens,
                "completionTokens": completion_tokens,
            },
        })

    except asyncio.CancelledError:
        # Session cancelled (stop button) — kill Claude Code subprocesses for this task
        _kill_all_cc_procs()
    except Exception as e:
        try:
            await ws.send_json({
                "type": "ai-inference-stream-error",
                "requestId": request_id,
                "error": str(e),
                "partialContent": partial_content or None,
            })
        except ConnectionResetError:
            pass


# ============================================================
# Transcription WebSocket (/ws/transcribe) — Three-stage pipeline:
#   Stage 1: Moonshine (immediate display, ~258ms TTFT)
#   Stage 2: Whisper vocab scan (parallel, ~1-2s later)
#   Stage 3: Ollama LLM gatekeeper (refinement + vocab gating)
# with vocabulary feedback loop via context provider
# ============================================================

# --- Moonshine (Stage 1) — lazy initialization ---
_moonshine_transcriber = None
_moonshine_available = None  # None = not yet checked, True/False = result

def _get_moonshine():
    """Lazy-initialize Moonshine transcriber. Returns Transcriber or None."""
    global _moonshine_transcriber, _moonshine_available
    if _moonshine_available is False:
        return None
    if _moonshine_transcriber is not None:
        return _moonshine_transcriber
    try:
        from moonshine_voice.transcriber import Transcriber
        from moonshine_voice.download import get_model_for_language
        model_path, model_arch = get_model_for_language("en")
        _moonshine_transcriber = Transcriber(model_path, model_arch)
        _moonshine_available = True
        plog(f"[Moonshine] Initialized (path: {model_path}, arch: {model_arch})")
        return _moonshine_transcriber
    except Exception as e:
        _moonshine_available = False
        plog(f"[Moonshine] Not available, falling back to Whisper-only: {e}")
        return None


# --- Fuzzy Alignment (pre-LLM) ---

def _align_whisper_to_moonshine(whisper_text: str, moonshine_text: str) -> tuple[str, int, int]:
    """Algorithmically align Whisper output to the corresponding Moonshine segment.

    Takes the Whisper chunk and finds the best-matching subsequence in the
    Moonshine transcript. Returns (aligned_moonshine_segment, start_word_idx, end_word_idx).

    The algorithm:
    1. Tokenize both into words (lowered for comparison)
    2. Use a sliding window over Moonshine words (window size = Whisper word count ± 30%)
    3. Score each window position by word overlap ratio
    4. Return the best-matching window as the aligned Moonshine segment

    This ensures the gatekeeper receives two versions of the SAME speech segment,
    making its refinement task trivial.
    """
    w_words = whisper_text.split()
    m_words = moonshine_text.split()

    if not w_words or not m_words:
        return moonshine_text, 0, len(m_words)

    # If Moonshine is shorter or roughly same length as Whisper, use it all
    if len(m_words) <= len(w_words) + 3:
        return moonshine_text, 0, len(m_words)

    w_lower = [w.lower().strip(".,!?;:'\"") for w in w_words]
    m_lower = [w.lower().strip(".,!?;:'\"") for w in m_words]

    # Build a set of Whisper words for fast lookup
    w_set = set(w_lower)

    # Try window sizes from 80% to 120% of Whisper word count
    best_score = -1.0
    best_start = 0
    best_end = len(m_words)

    min_win = max(1, int(len(w_words) * 0.7))
    max_win = min(len(m_words), int(len(w_words) * 1.4)) + 1

    for win_size in range(min_win, max_win):
        for start in range(0, len(m_words) - win_size + 1):
            window = m_lower[start:start + win_size]
            # Score: fraction of window words that appear in Whisper
            overlap = sum(1 for w in window if w in w_set)
            # Bonus for matching first/last words (anchoring)
            anchor_bonus = 0.0
            if window[0] == w_lower[0]:
                anchor_bonus += 0.15
            if window[-1] == w_lower[-1]:
                anchor_bonus += 0.15
            # Penalize size mismatch slightly
            size_penalty = abs(win_size - len(w_words)) / max(len(w_words), 1) * 0.1
            score = (overlap / win_size) + anchor_bonus - size_penalty
            if score > best_score:
                best_score = score
                best_start = start
                best_end = start + win_size

    aligned = " ".join(m_words[best_start:best_end])
    return aligned, best_start, best_end


# --- Ollama LLM Gatekeeper (Stage 3) ---
_OLLAMA_GATEKEEPER_MODEL = "qwen2.5:3b"

async def _ollama_gatekeeper(
    moonshine_text: str,
    whisper_text: str,
    vocab_list: list[str],
    recent_context: list[str],
) -> dict | None:
    """Stage 3: Call Ollama to refine transcript. Returns plain text.

    The LLM's only job is producing refined text. When a spoken word matches
    a vocabulary term, the LLM uses the EXACT casing from the vocab list
    (e.g. "ATARAXIA", "InterBrain", "DreamOS"). Regular word usage stays
    lowercase (e.g. "I love this" even though "Love" is a vocab term).

    Vocab hits are then detected downstream via case-sensitive regex on the
    refined text — completely decoupled from the LLM's task.

    Returns dict with keys: text (str), vocab_hits (list[str])
    or None on failure.
    """
    context_lines = "\n".join(f"  - {line}" for line in recent_context[-3:]) if recent_context else "  (none)"
    vocab_str = ", ".join(vocab_list) if vocab_list else "(none)"

    prompt = f"""Two transcriptions of the SAME spoken segment:
A: {moonshine_text}
B: {whisper_text}

Vocabulary (exact casing): {vocab_str}

Previous (for context only — do NOT repeat): {context_lines}

Produce ONE refined version. Rules:
- Merge A and B: use the more accurate word at each position
- Fix punctuation, capitalization, and word boundaries
- When a spoken word SOUNDS like a vocabulary term, use the vocabulary spelling (e.g. "attraxia" → "ATARAXIA", "dream notes" → "DreamNodes", "holo fractal" → "HolofractalUniverse")
- Regular speech stays lowercase even if it matches vocabulary (e.g. "I love this" — not the concept "Love")
- NEVER insert vocabulary casing inside another word ("wanna" stays "wanna", not "wAnna")
- Do NOT repeat context. Do NOT add unspoken words.
- Output ONLY the refined segment."""

    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(
                "http://127.0.0.1:11434/api/generate",
                json={
                    "model": _OLLAMA_GATEKEEPER_MODEL,
                    "prompt": prompt,
                    "stream": False,
                    "options": {"temperature": 0.1, "num_predict": 256},
                },
                timeout=aiohttp.ClientTimeout(total=15),
            ) as resp:
                if resp.status != 200:
                    plog(f"[Gatekeeper] Ollama HTTP {resp.status}")
                    return None
                body = await resp.json()
                raw = body.get("response", "").strip()

        if not raw:
            return None

        # Strip any accidental quotes or markdown the LLM may have added
        refined = raw.strip().strip('"').strip("'").strip()
        if refined.startswith("```"):
            refined = re.sub(r'^```\w*\s*', '', refined)
            refined = re.sub(r'\s*```$', '', refined)
            refined = refined.strip()

        if not refined:
            return None

        # Detect vocab hits via case-sensitive matching on the refined text.
        # A vocab term is a "hit" only if it appears with its EXACT casing —
        # the LLM's job was to use exact casing for intentional invocations.
        # Use word-boundary regex to avoid partial matches (e.g. "wAnna" != "Anna")
        vocab_hits = []
        for term in vocab_list:
            if len(term) < 3:
                continue
            # Escape regex special chars in term, match with word boundaries
            pattern = r'(?<![a-zA-Z])' + re.escape(term) + r'(?![a-zA-Z])'
            if re.search(pattern, refined):
                vocab_hits.append(term)

        plog(f"[Gatekeeper] Refined: {refined[:80]}...")
        if vocab_hits:
            plog(f"[Gatekeeper] Vocab hits (case-sensitive): {vocab_hits}")

        return {"text": refined, "vocab_hits": vocab_hits}

    except asyncio.TimeoutError:
        plog(f"[Gatekeeper] Ollama timeout (15s)")
        return None
    except Exception as e:
        plog(f"[Gatekeeper] Error: {e}")
        return None


# --- Moonshine audio decoding helper ---
async def _decode_webm_chunk_to_pcm(webm_data: bytes) -> list[float] | None:
    """Decode webm/opus audio bytes to PCM float samples at 16kHz mono.
    Returns list of floats or None on failure."""
    proc = await asyncio.create_subprocess_exec(
        "ffmpeg", "-y", "-i", "pipe:0",
        "-ar", "16000", "-ac", "1", "-f", "f32le", "pipe:1",
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, _ = await proc.communicate(input=webm_data)
    if proc.returncode != 0 or not stdout:
        return None
    # Convert raw f32le bytes to list of floats
    num_samples = len(stdout) // 4
    return list(struct.unpack(f'{num_samples}f', stdout))


# mlx-whisper model mapping (size -> HuggingFace repo)
_MLX_WHISPER_MODELS = {
    "tiny": "mlx-community/whisper-tiny",
    "base": "mlx-community/whisper-base-mlx",
    "small": "mlx-community/whisper-small-mlx",
    "medium": "mlx-community/whisper-medium-mlx",
    "large": "mlx-community/whisper-large-v3-mlx",
    "turbo": "mlx-community/whisper-large-v3-turbo",
}
_whisper_model_size = "medium"
_whisper_repo: str = _MLX_WHISPER_MODELS["medium"]
_whisper_async_repo: str = _MLX_WHISPER_MODELS["turbo"]
def _transcribe_sync(wav_path: str, prompt: str = "", repo: str | None = None) -> dict:
    """Synchronous Whisper transcription. Called from run_in_executor."""
    import mlx_whisper
    return mlx_whisper.transcribe(
        wav_path,
        path_or_hf_repo=repo or _whisper_repo,
        language="en",
        initial_prompt=prompt or None,
    )


async def _probe_duration_file(path: str) -> float | None:
    """Get duration in seconds of an audio file on disk."""
    proc = await asyncio.create_subprocess_exec(
        "ffprobe", "-v", "quiet", "-show_entries", "format=duration",
        "-of", "csv=p=0", path,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, _ = await proc.communicate()
    try:
        return float(stdout.decode().strip())
    except (ValueError, AttributeError):
        return None


async def _extract_time_range_file(path: str, start_sec: float, max_duration: float | None = None) -> str | None:
    """Extract audio from start_sec into a WAV file. Optionally limit duration."""
    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    tmp.close()
    cmd = ["ffmpeg", "-y", "-ss", f"{start_sec:.2f}", "-i", path]
    if max_duration is not None:
        cmd.extend(["-t", f"{max_duration:.2f}"])
    cmd.extend(["-ar", "16000", "-ac", "1", tmp.name])
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    await proc.communicate()
    if proc.returncode != 0:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass
        return None
    return tmp.name


async def _decode_webm_to_wav(webm_data: bytes) -> str | None:
    """Decode webm/opus audio to a temporary WAV file for Whisper."""
    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    tmp.close()
    proc = await asyncio.create_subprocess_exec(
        "ffmpeg", "-y", "-i", "pipe:0",
        "-ar", "16000", "-ac", "1", tmp.name,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await proc.communicate(input=webm_data)
    if proc.returncode != 0:
        os.unlink(tmp.name)
        return None
    return tmp.name


def _filter_hallucination(text: str) -> str:
    """Drop text if Whisper is hallucinating (repeated words/phrases on silence)."""
    words = text.split()
    if len(words) < 4:
        return text
    # If any single word makes up >60% of the text, it's a hallucination loop
    counts = Counter(w.lower().strip(".,!?") for w in words)
    most_common_word, most_common_count = counts.most_common(1)[0]
    if most_common_count / len(words) > 0.6:
        return ""
    # If a 2-3 word phrase repeats >4 times, also hallucination
    for n in (2, 3):
        if len(words) < n * 4:
            continue
        ngrams = [" ".join(words[i:i+n]).lower() for i in range(len(words) - n + 1)]
        ngram_counts = Counter(ngrams)
        top_ngram, top_count = ngram_counts.most_common(1)[0]
        if top_count > 4:
            return ""
    return text


_CORE_VOCAB = [
    "AURYN", "InterBrain", "DreamNode", "DreamOS", "DreamTalk",
    "DreamSong", "PRISM", "ABRACADABRA", "Radicle",
]

# Max terms in Whisper's initial_prompt.
# R&D (2026-03-05): medium model tested up to 100 terms with zero quality
# degradation and no speed penalty. The old limit of 20 was from tiny/base.
_MAX_VOCAB_TERMS = 50


def _build_vocab_prompt(
    pinned: list[str] | None = None,
    ephemeral: list[str] | None = None,
) -> str:
    """Build Whisper initial_prompt from pinned + ephemeral DreamNode titles.

    Medium model tested up to 100 terms with no quality degradation.
    Cap at 50 for now — conservative margin with room to grow.

    Two tiers:
    - Pinned: Core vocab + any DreamNode whose name was recognized in the
      transcript. Once mentioned, stays for the entire session.
    - Ephemeral: BM25 context provider suggestions from recent transcript.
      These rotate as conversation shifts. Fill remaining slots up to cap.
    """
    terms: list[str] = []
    seen = set()

    def _add(name: str):
        if name.lower() not in seen and len(name) >= 3:
            seen.add(name.lower())
            terms.append(name)

    # 1. Core DreamOS vocabulary — always present
    for term in _CORE_VOCAB:
        _add(term)

    # 2. Session-pinned titles (DreamNodes whose name appeared in transcript)
    if pinned:
        for t in pinned:
            _add(t)

    # 3. Ephemeral BM25 suggestions — fill remaining slots
    remaining = _MAX_VOCAB_TERMS - len(terms)
    if ephemeral and remaining > 0:
        for t in ephemeral[:remaining]:
            _add(t)

    if not terms:
        return ""

    return ", ".join(terms)


async def ws_transcribe(request: web.Request) -> web.WebSocketResponse:
    ws = web.WebSocketResponse()
    await ws.prepare(request)

    loop = asyncio.get_event_loop()

    session_id: str | None = None
    audio_file = None
    orig_filename: str = ""
    transcript_parts: list[str] = []
    start_time: float = 0.0
    cumulative_webm = bytearray()
    last_processed_bytes = 0
    chunk_interval = 8.0  # seconds between Whisper transcription passes
    process_task: asyncio.Task | None = None
    moonshine_task: asyncio.Task | None = None
    async_task: asyncio.Task | None = None
    pipeline_mode: str = "async"  # "sync" or "async"

    # Vocabulary feedback loop state
    context_index = load_index()
    pinned_vocab: list[str] = []   # DreamNodes whose name appeared in transcript (permanent)
    ephemeral_vocab: list[str] = []  # BM25 suggestions from recent text (rotating)
    sliding_window: list[str] = []  # last N transcript chunks for BM25 context

    SLIDING_WINDOW_SIZE = 5  # ~40-60 seconds of conversation context

    # Build vocab lookup: multiple key forms -> {folder, title, uuid, path}
    # Keys: folder (lowered), title (lowered), collapsed spaced title, camelCase-split
    # This is the single lookup table: title -> (uuid, path) for the whole system
    _vocab_lookup: dict[str, dict] = {}
    if context_index and "nodes" in context_index:
        for node in context_index["nodes"]:
            folder = node.get("folder", "")
            title = node.get("title", "")
            info = {
                "folder": folder, "title": title,
                "uuid": node.get("uuid", ""), "path": node.get("path", ""),
            }
            # Index by folder name
            if folder:
                _vocab_lookup[folder.lower()] = info
            # Index by title
            if title:
                _vocab_lookup[title.lower()] = info
            # Collapsed spaced titles (A U R Y N -> auryn)
            collapsed = re.sub(r"\s+", "", title).lower()
            if collapsed and collapsed not in _vocab_lookup:
                _vocab_lookup[collapsed] = info
            # CamelCase-split (InterBrain -> inter brain)
            camel_words = _split_camel(folder)
            if len(camel_words) > 1:
                joined = " ".join(camel_words)
                if joined not in _vocab_lookup:
                    _vocab_lookup[joined] = info

    vocab_prompt = _build_vocab_prompt()
    print(f"[Whisper] Initial vocab: {vocab_prompt}")

    _transcript_file: Path | None = None

    def _start_transcript_session(recording_name: str, session_start: float):
        """Write a session header to the daily transcript file."""
        nonlocal _transcript_file
        _transcript_file = TRANSCRIPTS_DIR / f"{datetime.now().strftime('%Y-%m-%d')}.md"
        wall_time = datetime.now().strftime("%H:%M")
        with open(_transcript_file, "a", encoding="utf-8") as f:
            f.write(f"\n---\n\n### {wall_time} · `{recording_name}`\n\n")
            f.flush()

    def _write_transcript_chunk(text: str, session_start: float):
        """Append a confirmed transcript chunk to the daily file."""
        elapsed = time.time() - session_start
        minutes = int(elapsed // 60)
        seconds = int(elapsed % 60)
        timestamp = f"{minutes}:{seconds:02d}"
        if _transcript_file is None:
            return
        with open(_transcript_file, "a", encoding="utf-8") as f:
            f.write(f"[{timestamp}] {text}\n\n")
            f.flush()

    def _check_vocab_hits(text: str) -> list[dict]:
        """Check if any DreamNode names appear in the transcribed text.
        Case-sensitive exact match against canonical folder/title forms.
        If Whisper was vocab-primed and still didn't produce the exact casing,
        that's signal it wasn't actually said — don't pretend otherwise."""
        hits = []
        seen_uuids = set()
        # Collect unique canonical names (folder, title) per uuid
        canonical: dict[str, list[str]] = {}  # uuid -> [name1, name2, ...]
        info_by_uuid: dict[str, dict] = {}
        for info in _vocab_lookup.values():
            uid = info["uuid"]
            if uid in canonical:
                continue
            names = set()
            if info["folder"]:
                names.add(info["folder"])
            if info["title"]:
                names.add(info["title"])
            canonical[uid] = list(names)
            info_by_uuid[uid] = info
        for uid, names in canonical.items():
            if uid in seen_uuids:
                continue
            for name in names:
                if len(name) <= 3:
                    if re.search(r'(?<![a-zA-Z])' + re.escape(name) + r'(?![a-zA-Z])', text):
                        hits.append(info_by_uuid[uid])
                        seen_uuids.add(uid)
                        break
                else:
                    if name in text:
                        hits.append(info_by_uuid[uid])
                        seen_uuids.add(uid)
                        break
        return hits

    def _update_ephemeral_vocab(text: str):
        """Run BM25 on recent transcript (sliding window), update ephemeral suggestions."""
        nonlocal ephemeral_vocab

        # Update sliding window
        sliding_window.append(text)
        if len(sliding_window) > SLIDING_WINDOW_SIZE:
            sliding_window.pop(0)

        if not context_index:
            return

        # BM25 on the sliding window
        window_text = " ".join(sliding_window)
        results = context_search(window_text, context_index, top_k=10)

        # Ephemeral = top BM25 hits that aren't already pinned or core.
        # No score threshold — if BM25 ranked it in the top 10, it's relevant
        # enough to bias Whisper. The slot cap (20 total) is the only limit.
        pinned_set = {p.lower() for p in pinned_vocab}
        core_set = {t.lower() for t in _CORE_VOCAB}
        remaining_slots = _MAX_VOCAB_TERMS - len(_CORE_VOCAB) - len(pinned_vocab)
        new_ephemeral = []
        for r in results:
            if remaining_slots <= 0:
                break
            title = r.get("title", "")
            if not title:
                continue
            if title.lower() not in pinned_set and title.lower() not in core_set:
                new_ephemeral.append(title)
                remaining_slots -= 1

        if new_ephemeral != ephemeral_vocab:
            ephemeral_vocab = new_ephemeral
            plog(f"[Whisper] Ephemeral vocab updated: {ephemeral_vocab[:5]}")

    def _rebuild_prompt():
        """Rebuild the vocab prompt from current pinned + ephemeral state."""
        nonlocal vocab_prompt
        vocab_prompt = _build_vocab_prompt(pinned_vocab, ephemeral_vocab)

    async def _send_vocab_state():
        """Send current vocabulary state to UI for debugging."""
        try:
            await ws.send_json({
                "type": "vocab_update",
                "core": list(_CORE_VOCAB),
                "pinned": list(pinned_vocab),
                "ephemeral": list(ephemeral_vocab),
                "prompt": vocab_prompt,
            })
        except Exception:
            pass

    async def _notify_dreamnode_hit(info: dict):
        """Send dreamnode_detected message to UI when a name is recognized."""
        try:
            await ws.send_json({
                "type": "dreamnode_detected",
                "folder": info["folder"],
                "title": info["title"],
                "uuid": info["uuid"],
                "path": info.get("path", ""),
            })
        except Exception:
            pass

    def _fix_capitalization(text: str, titles: list[str]) -> str:
        """Fix capitalization of DreamNode titles in text that was transcribed
        before the term was in the vocab prompt. Case-insensitive replace
        with the canonical title form."""
        for title in titles:
            pattern = re.compile(re.escape(title), re.IGNORECASE)
            text = pattern.sub(title, text)
        return text

    async def _process_new_text(new_text: str, notify_hits: bool = True) -> str:
        """Process newly transcribed text: check vocab hits, update feedback loop.
        When notify_hits=False, pins vocab terms but doesn't send DreamNode
        detection to UI (used when gatekeeper will be the authoritative source).
        Returns the (possibly corrected) text."""
        # 1. Check for DreamNode name matches (Tier 1 vocab) → pin them
        hits = _check_vocab_hits(new_text)
        core_set = {t.lower() for t in _CORE_VOCAB}
        new_pins = False
        newly_pinned_titles = []
        for info in hits:
            title = info["title"]
            # Don't duplicate core vocab in pinned list
            if title not in pinned_vocab and title.lower() not in core_set:
                pinned_vocab.append(title)
                newly_pinned_titles.append(title)
                new_pins = True
                plog(f"[Whisper] PINNED: {title} (uuid={info['uuid']}, path={info['path']})")
            # Notify UI of DreamNode detection only if authoritative
            if notify_hits:
                await _notify_dreamnode_hit(info)

        # Fix capitalization in *this* chunk for newly pinned titles
        # (the chunk was transcribed before these terms were in the prompt)
        if newly_pinned_titles:
            new_text = _fix_capitalization(new_text, newly_pinned_titles)

        # 2. Update ephemeral vocab via BM25 sliding window
        _update_ephemeral_vocab(new_text)

        # 3. Rebuild prompt if anything changed
        if new_pins or True:  # always rebuild to reflect ephemeral changes
            _rebuild_prompt()

        return new_text

    last_transcribed_sec = 0.0  # seconds of audio already transcribed

    # --- Three-stage pipeline state ---
    moonshine = _get_moonshine()
    moonshine_interval = 3.0  # Stage 1: fast cycle (3s)
    moonshine_last_sec = 0.0  # audio seconds already processed by Moonshine
    # Track Moonshine chunks by index for retroactive correction
    moonshine_chunk_index = 0  # incremented for each Moonshine chunk sent to UI
    whisper_last_sec = 0.0  # audio seconds already processed by Whisper
    # Running Moonshine transcript — words accumulate here, gatekeeper corrects in-place
    # Each entry tracks: original word, chunk_index it came from, whether it's been refined
    moonshine_words: list[dict] = []  # [{word, chunk_index, refined}]
    # History of refined chunks for gatekeeper context (last N refined outputs)
    refined_history: list[str] = []

    def _moonshine_transcribe_sync(wav_path: str) -> str:
        """Synchronous Moonshine transcription (non-streaming). Called from executor."""
        try:
            from moonshine_voice.utils import load_wav_file
            audio_data, sample_rate = load_wav_file(wav_path)
            result = moonshine.transcribe_without_streaming(audio_data, sample_rate=sample_rate)
            return " ".join(line.text.strip() for line in result.lines if line.text.strip())
        except Exception as e:
            plog(f"[Moonshine] Transcription error: {e}")
            return ""

    async def periodic_moonshine():
        """Stage 1: Moonshine fast transcription every moonshine_interval seconds.
        Sends transcript_chunk immediately for low-latency display."""
        nonlocal moonshine_last_sec, moonshine_chunk_index
        while True:
            await asyncio.sleep(moonshine_interval)
            if not audio_file or not audio_file.exists():
                plog(f"[Moonshine] No audio file yet")
                continue

            total_sec = time.time() - start_time
            if total_sec - moonshine_last_sec < moonshine_interval * 0.5:
                continue  # not enough new audio

            # Extract new audio (small overlap for context)
            overlap = 0.5 if moonshine_last_sec > 0 else 0.0
            extract_from = max(0, moonshine_last_sec - overlap)
            wav_path = await _extract_time_range_file(str(audio_file), extract_from)
            if not wav_path:
                plog(f"[Moonshine] Audio extraction failed (from {extract_from:.1f}s)")
                continue

            try:
                new_text = await loop.run_in_executor(None, _moonshine_transcribe_sync, wav_path)
                plog(f"[Moonshine] Raw output: '{new_text[:80]}'" if new_text else "[Moonshine] Empty output")
                new_text = _filter_hallucination(new_text)

                if new_text:
                    chunk_idx = moonshine_chunk_index
                    moonshine_chunk_index += 1
                    # Append words to running transcript for alignment
                    for word in new_text.split():
                        moonshine_words.append({
                            "word": word,
                            "chunk_index": chunk_idx,
                            "refined": False,
                        })

                    # Send immediately — this is the fast path
                    chunk_text = " " + new_text if transcript_parts else new_text
                    await ws.send_json({
                        "type": "transcript_chunk",
                        "text": chunk_text,
                        "chunk_index": chunk_idx,
                        "stage": "moonshine",
                    })
                    transcript_parts.append(new_text)
                    _write_transcript_chunk(new_text, start_time)
                    plog(f"[Moonshine] Chunk {chunk_idx}: {new_text[:80]}...")

                moonshine_last_sec = total_sec

            except Exception as e:
                plog(f"[Moonshine] Error: {e}")
            finally:
                try:
                    os.unlink(wav_path)
                except OSError:
                    pass

    async def periodic_whisper_and_gatekeeper():
        """Stage 2+3: Whisper vocabulary oracle + Ollama gatekeeper refinement.

        Architecture:
        1. Whisper transcribes the latest audio window (vocab-primed)
        2. Fuzzy alignment finds the corresponding Moonshine segment
        3. Gatekeeper receives aligned pair + vocab + context → refined text
        4. Refined text splices into the Moonshine transcript in-place
        5. Vocab hits detected via case-sensitive regex on refined text

        The Moonshine transcript is the living document. Each gatekeeper pass
        corrects a segment of it. Previously refined segments provide context
        for future passes, accumulating quality forward.
        """
        nonlocal last_processed_bytes, last_transcribed_sec, whisper_last_sec
        while True:
            await asyncio.sleep(chunk_interval)
            if not audio_file or not audio_file.exists():
                continue
            if len(cumulative_webm) <= last_processed_bytes:
                continue

            total_sec = time.time() - start_time

            # Snapshot the window boundary before advancing
            window_start = whisper_last_sec

            # Advance immediately so the next cycle uses a fresh window
            whisper_last_sec = total_sec
            last_transcribed_sec = total_sec
            last_processed_bytes = len(cumulative_webm)

            # Extract audio for this window
            overlap = 1.5 if window_start > 0 else 0.0
            extract_from = max(0, window_start - overlap)
            wav_path = await _extract_time_range_file(str(audio_file), extract_from)
            if not wav_path:
                continue

            try:
                # Stage 2: Whisper with vocab-primed prompt
                prompt = vocab_prompt
                if refined_history:
                    # Use last refined output as Whisper context (better than raw Moonshine)
                    recent = refined_history[-1]
                    prompt = vocab_prompt + ". " + recent if vocab_prompt else recent
                elif transcript_parts:
                    recent = transcript_parts[-1]
                    prompt = vocab_prompt + ". " + recent if vocab_prompt else recent

                result = await loop.run_in_executor(
                    None,
                    lambda p=prompt, w=wav_path: _transcribe_sync(w, p),
                )

                segs = result["segments"]
                if overlap > 0 and segs:
                    segs = [s for s in segs
                            if (s["start"] + s["end"]) / 2 >= overlap]

                whisper_text = " ".join(
                    s["text"].strip() for s in segs
                ).strip()
                whisper_text = _filter_hallucination(whisper_text)

                if not whisper_text:
                    continue

                # Update vocab state (pinning, ephemeral BM25) but do NOT
                # notify DreamNode hits — gatekeeper is authoritative
                whisper_text = await _process_new_text(whisper_text, notify_hits=False)
                await _send_vocab_state()

                # --- Fuzzy alignment: find the Moonshine segment matching this Whisper chunk ---
                # Build the unrefined portion of the Moonshine transcript
                unrefined_words = [mw for mw in moonshine_words if not mw["refined"]]
                if not unrefined_words:
                    continue

                unrefined_text = " ".join(mw["word"] for mw in unrefined_words)
                aligned_moon, align_start, align_end = _align_whisper_to_moonshine(
                    whisper_text, unrefined_text
                )

                # Use precise alignment — no chunk boundary snapping
                aligned_word_entries = unrefined_words[align_start:align_end]
                chunk_indices = sorted(set(mw["chunk_index"] for mw in aligned_word_entries))

                plog(f"[Alignment] Whisper ({len(whisper_text.split())}w) aligned to Moonshine ({align_end - align_start}w of {len(unrefined_words)}w unrefined, chunks {chunk_indices})")
                plog(f"[Gatekeeper] Input A (Moonshine, chunks {chunk_indices}): {aligned_moon[:120]}...")
                plog(f"[Gatekeeper] Input B (Whisper): {whisper_text[:120]}...")

                # Stage 3: Gatekeeper — build full vocab list
                seen_vocab = set()
                all_vocab = []
                for t in list(_CORE_VOCAB) + list(pinned_vocab) + list(ephemeral_vocab):
                    if t.lower() not in seen_vocab:
                        seen_vocab.add(t.lower())
                        all_vocab.append(t)
                if context_index and "nodes" in context_index:
                    for node in context_index["nodes"]:
                        folder = node.get("folder", "")
                        title = node.get("title", "")
                        name = folder if folder and len(folder) >= 3 else title
                        if name and name.lower() not in seen_vocab and len(name) >= 3:
                            seen_vocab.add(name.lower())
                            all_vocab.append(name)

                # Context: last 2 refined outputs (already corrected, high quality)
                context_for_gatekeeper = list(refined_history[-2:])

                gatekeeper_result = await _ollama_gatekeeper(
                    aligned_moon, whisper_text, all_vocab, context_for_gatekeeper
                )

                if gatekeeper_result and gatekeeper_result["text"].strip():
                    refined = gatekeeper_result["text"].strip()

                    # Mark aligned words as refined in moonshine_words
                    for mw in aligned_word_entries:
                        mw["refined"] = True

                    # Add to refined history for future context
                    refined_history.append(refined)
                    if len(refined_history) > 5:
                        refined_history.pop(0)

                    # Send correction to UI — text-based replacement
                    if refined != aligned_moon:
                        await ws.send_json({
                            "type": "transcript_correction",
                            "find_text": aligned_moon,
                            "replace_text": refined,
                            "stage": "gatekeeper",
                        })
                        _write_transcript_chunk(f"[refined] {refined}", start_time)
                        plog(f"[Gatekeeper] Correction: {refined[:80]}...")

                    # Process vocab hits from gatekeeper (authoritative)
                    core_lower = {t.lower() for t in _CORE_VOCAB}
                    for term in gatekeeper_result.get("vocab_hits", []):
                        info = _vocab_lookup.get(term.lower())
                        if info:
                            if term not in pinned_vocab and info["title"].lower() not in core_lower:
                                pinned_vocab.append(info["title"])
                                plog(f"[Gatekeeper] PINNED: {info['title']}")
                            await _notify_dreamnode_hit(info)
                    _rebuild_prompt()
                else:
                    plog(f"[Gatekeeper] No refinement produced")

            except Exception as e:
                plog(f"[Pipeline Stage 2+3] Error: {e}")
            finally:
                try:
                    os.unlink(wav_path)
                except OSError:
                    pass

    # --- Async pipeline: high-quality Whisper-only, 30s chunks, no gatekeeper ---
    async_chunk_interval = 30.0
    async_overlap = 3.0
    async_whisper_last_sec = 0.0

    async def periodic_whisper_async():
        """Async mode: double-pass Whisper (turbo) every 30s. No Moonshine, no gatekeeper.

        Double-pass strategy:
        1. First pass: transcribe with current vocab prompt (from previous chunks)
        2. Run BM25 on first-pass text to discover relevant DreamNode vocab
        3. Second pass: re-transcribe same audio with enriched vocab prompt
        4. Send second-pass result as transcript_full

        This means the very first mention of a term benefits from vocab priming,
        rather than waiting until the next chunk.
        """
        nonlocal async_whisper_last_sec, last_transcribed_sec, last_processed_bytes
        while True:
            await asyncio.sleep(async_chunk_interval)
            if not audio_file or not audio_file.exists():
                continue
            if len(cumulative_webm) <= last_processed_bytes:
                continue

            total_sec = time.time() - start_time
            window_start = async_whisper_last_sec

            # Advance immediately
            async_whisper_last_sec = total_sec
            last_transcribed_sec = total_sec
            last_processed_bytes = len(cumulative_webm)

            # Extract audio with overlap
            overlap = async_overlap if window_start > 0 else 0.0
            extract_from = max(0, window_start - overlap)
            wav_path = await _extract_time_range_file(str(audio_file), extract_from)
            if not wav_path:
                continue

            try:
                # --- Pass 1: transcribe with current vocab ---
                prompt1 = vocab_prompt
                if transcript_parts:
                    recent = transcript_parts[-1]
                    prompt1 = vocab_prompt + ". " + recent if vocab_prompt else recent

                result1 = await loop.run_in_executor(
                    None,
                    lambda p=prompt1, w=wav_path: _transcribe_sync(w, p, _whisper_async_repo),
                )

                segs1 = result1["segments"]
                if overlap > 0 and segs1:
                    segs1 = [s for s in segs1
                             if (s["start"] + s["end"]) / 2 >= overlap]

                pass1_text = " ".join(
                    s["text"].strip() for s in segs1
                ).strip()
                pass1_text = _filter_hallucination(pass1_text)

                if not pass1_text:
                    continue

                plog(f"[Async] Pass 1: {pass1_text[:100]}...")

                # --- Update vocab from pass 1 text (BM25 + pinning) ---
                # This enriches the vocab prompt BEFORE pass 2
                _update_ephemeral_vocab(pass1_text)
                _rebuild_prompt()

                # --- Pass 2: re-transcribe with enriched vocab ---
                prompt2 = vocab_prompt
                if transcript_parts:
                    recent = transcript_parts[-1]
                    prompt2 = vocab_prompt + ". " + recent if vocab_prompt else recent

                result2 = await loop.run_in_executor(
                    None,
                    lambda p=prompt2, w=wav_path: _transcribe_sync(w, p, _whisper_async_repo),
                )

                segs2 = result2["segments"]
                if overlap > 0 and segs2:
                    segs2 = [s for s in segs2
                             if (s["start"] + s["end"]) / 2 >= overlap]

                new_text = " ".join(
                    s["text"].strip() for s in segs2
                ).strip()
                new_text = _filter_hallucination(new_text)

                if not new_text:
                    continue

                plog(f"[Async] Pass 2: {new_text[:100]}...")

                # Process vocab hits from final text (pinning + DreamNode notifications)
                new_text = await _process_new_text(new_text, notify_hits=True)
                await _send_vocab_state()

                # Append to transcript parts
                transcript_parts.append(new_text)
                _write_transcript_chunk(new_text, start_time)

                # Send full transcript to UI — single source of truth
                full = " ".join(transcript_parts)
                await ws.send_json({
                    "type": "transcript_full",
                    "text": full,
                })

            except Exception as e:
                plog(f"[Async Pipeline] Error: {e}")
            finally:
                try:
                    os.unlink(wav_path)
                except OSError:
                    pass

    async for msg in ws:
        if msg.type == aiohttp.WSMsgType.TEXT:
            try:
                data = json.loads(msg.data)
            except json.JSONDecodeError:
                continue

            if data.get("type") == "start_stream":
                session_id = str(uuid.uuid4())
                start_time = time.time()
                transcript_parts.clear()
                cumulative_webm.clear()
                last_processed_bytes = 0
                last_transcribed_sec = 0.0
                moonshine_last_sec = 0.0
                whisper_last_sec = 0.0
                moonshine_chunk_index = 0
                moonshine_words.clear()
                refined_history.clear()
                pinned_vocab.clear()
                ephemeral_vocab.clear()
                sliding_window.clear()
                vocab_prompt = _build_vocab_prompt()

                RECORDINGS_DIR.mkdir(exist_ok=True)
                TRANSCRIPTS_DIR.mkdir(exist_ok=True)

                ts = datetime.now().strftime("%Y%m%d-%H%M%S")
                # Use the original filename's extension if provided (file drops),
                # default to .webm for live mic recording
                orig_filename = data.get("filename", "")
                if orig_filename:
                    ext = Path(orig_filename).suffix or ".webm"
                else:
                    ext = ".webm"
                audio_file = RECORDINGS_DIR / f"{ts}{ext}"
                _start_transcript_session(f"{ts}{ext}", start_time)

                # Cancel any existing pipeline tasks before launching new ones
                for t in [moonshine_task, process_task, async_task]:
                    if t is not None:
                        t.cancel()
                moonshine_task = None
                process_task = None
                async_task = None

                # Read pipeline mode from client
                pipeline_mode = data.get("pipeline_mode", "async")

                if pipeline_mode == "sync":
                    # Three-stage: Moonshine → Whisper → Gatekeeper
                    moonshine_task = asyncio.create_task(periodic_moonshine())
                    process_task = asyncio.create_task(periodic_whisper_and_gatekeeper())
                    plog(f"[Pipeline] Started: Moonshine→Whisper→Gatekeeper (sync mode)")
                else:
                    # Async: high-quality Whisper turbo only, 30s chunks
                    async_whisper_last_sec = 0.0
                    async_task = asyncio.create_task(periodic_whisper_async())
                    plog(f"[Pipeline] Started: Whisper turbo 30s chunks (async mode)")

                await ws.send_json({"type": "session_started", "session_id": session_id, "pipeline": pipeline_mode})

            elif data.get("type") == "end_stream":
                # Cancel all pipeline tasks
                for t in [moonshine_task, process_task, async_task]:
                    if t is not None:
                        t.cancel()
                        try:
                            await t
                        except asyncio.CancelledError:
                            pass
                moonshine_task = None
                process_task = None
                async_task = None

                # Final transcription pass — only the tail not yet transcribed
                # Use actual file duration (not wall clock) to handle file drops
                # where all bytes arrive instantly
                file_duration = await _probe_duration_file(str(audio_file)) if audio_file and audio_file.exists() else None
                elapsed = max(time.time() - start_time, file_duration or 0)
                if audio_file and audio_file.exists() and last_transcribed_sec < (elapsed - 1):
                    wav_path = await _extract_time_range_file(
                        str(audio_file), last_transcribed_sec
                    )
                    if wav_path:
                        try:
                            if pipeline_mode == "async":
                                # Double-pass: same logic as periodic_whisper_async
                                # Pass 1: transcribe with current vocab
                                prompt1 = vocab_prompt
                                if transcript_parts:
                                    prompt1 = vocab_prompt + ". " + transcript_parts[-1] if vocab_prompt else transcript_parts[-1]

                                result1 = await loop.run_in_executor(
                                    None,
                                    lambda p=prompt1, w=wav_path: _transcribe_sync(w, p, _whisper_async_repo),
                                )
                                pass1_text = " ".join(
                                    s["text"].strip() for s in result1["segments"]
                                ).strip()
                                pass1_text = _filter_hallucination(pass1_text)

                                if pass1_text:
                                    plog(f"[Async Final] Pass 1: {pass1_text[:100]}...")
                                    # Enrich vocab from pass 1
                                    _update_ephemeral_vocab(pass1_text)
                                    _rebuild_prompt()

                                    # Pass 2: re-transcribe with enriched vocab
                                    prompt2 = vocab_prompt
                                    if transcript_parts:
                                        prompt2 = vocab_prompt + ". " + transcript_parts[-1] if vocab_prompt else transcript_parts[-1]

                                    result2 = await loop.run_in_executor(
                                        None,
                                        lambda p=prompt2, w=wav_path: _transcribe_sync(w, p, _whisper_async_repo),
                                    )
                                    new_text = " ".join(
                                        s["text"].strip() for s in result2["segments"]
                                    ).strip()
                                    new_text = _filter_hallucination(new_text)

                                    if new_text:
                                        plog(f"[Async Final] Pass 2: {new_text[:100]}...")
                                        new_text = await _process_new_text(new_text, notify_hits=True)
                                        transcript_parts.append(new_text)
                                        full = " ".join(transcript_parts)
                                        await ws.send_json({"type": "transcript_full", "text": full})
                                        _write_transcript_chunk(new_text, start_time)
                                        await _send_vocab_state()
                            else:
                                # Sync mode: single pass with medium model
                                prompt = vocab_prompt
                                if transcript_parts:
                                    prompt = vocab_prompt + ". " + transcript_parts[-1] if vocab_prompt else transcript_parts[-1]

                                result = await loop.run_in_executor(
                                    None,
                                    lambda: _transcribe_sync(wav_path, prompt),
                                )
                                new_text = " ".join(
                                    s["text"].strip() for s in result["segments"]
                                ).strip()
                                new_text = _filter_hallucination(new_text)
                                if new_text:
                                    new_text = await _process_new_text(new_text)
                                    transcript_parts.append(new_text)
                                    chunk_text = " " + new_text if transcript_parts else new_text
                                    await ws.send_json({"type": "transcript_chunk", "text": chunk_text})
                                    _write_transcript_chunk(new_text, start_time)
                                    await _send_vocab_state()
                        except Exception as e:
                            print(f"[Whisper] Final transcription error: {e}")
                        finally:
                            try:
                                os.unlink(wav_path)
                            except OSError:
                                pass

                # For file drops (not mic recordings), copy to context dir
                # so AURYN knows the persistent path
                context_path = None
                if orig_filename and audio_file and audio_file.exists():
                    CONTEXT_DIR.mkdir(parents=True, exist_ok=True)
                    context_dest = CONTEXT_DIR / audio_file.name
                    shutil.copy2(str(audio_file), str(context_dest))
                    context_path = str(context_dest)

                # Send final state: all pinned DreamNodes from the session
                full_text = " ".join(transcript_parts)
                response: dict = {
                    "type": "stream_ended",
                    "full_text": full_text,
                    "pinned_dreamnodes": pinned_vocab,
                }
                if context_path:
                    response["file_path"] = context_path
                await ws.send_json(response)
                session_id = None

        elif msg.type == aiohttp.WSMsgType.BINARY:
            if len(cumulative_webm) == 0:
                plog(f"[Audio] First binary chunk received ({len(msg.data)} bytes)")
            cumulative_webm.extend(msg.data)
            if audio_file:
                with open(audio_file, "ab") as f:
                    f.write(msg.data)

        elif msg.type in (aiohttp.WSMsgType.ERROR, aiohttp.WSMsgType.CLOSE):
            break

    for t in [process_task, moonshine_task, async_task]:
        if t is not None:
            t.cancel()

    return ws


# ============================================================
# Audio upload (POST /upload/audio) — Whisper with vocabulary
# ============================================================

## handle_audio_upload removed — file transcription now uses the same
## WebSocket pipeline (/ws/transcribe) as live mic recording.


# ============================================================
# Static file serving
# ============================================================

async def handle_index(request: web.Request) -> web.Response:
    return web.Response(
        text=request.app["injected_html"],
        content_type="text/html",
    )


async def handle_static(request: web.Request) -> web.StreamResponse:
    rel_path = request.match_info.get("path", "")
    file_path = (AURYN_DIR / rel_path).resolve()

    if not str(file_path).startswith(str(AURYN_DIR)):
        raise web.HTTPForbidden()
    if not file_path.is_file():
        raise web.HTTPNotFound()

    return web.FileResponse(file_path)


# ============================================================
# File Upload & Context Directory
# ============================================================

def _cleanup_context_dir() -> int:
    """Remove files older than CONTEXT_MAX_AGE_DAYS from CONTEXT_DIR. Returns count removed."""
    if not CONTEXT_DIR.exists():
        return 0
    cutoff = time.time() - CONTEXT_MAX_AGE_DAYS * 86400
    removed = 0
    for f in CONTEXT_DIR.iterdir():
        if f.is_file() and f.stat().st_mtime < cutoff:
            f.unlink()
            removed += 1
    return removed


def _save_to_context(filename: str, data: bytes) -> Path:
    """Save uploaded file to context directory with timestamp prefix. Returns the saved path."""
    CONTEXT_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    # Sanitize filename: keep only the basename, replace spaces with underscores
    safe_name = Path(filename).name.replace(" ", "_")
    dest = CONTEXT_DIR / f"{ts}_{safe_name}"
    dest.write_bytes(data)
    return dest


async def handle_upload(request: web.Request) -> web.Response:
    """Accept any file upload via multipart POST. Saves to ~/.auryn/context/ and returns the path."""
    reader = await request.multipart()
    saved_files = []

    async for field in reader:
        if field.filename:
            data = await field.read(decode=False)
            dest = _save_to_context(field.filename, data)
            saved_files.append({
                "filename": field.filename,
                "path": str(dest),
                "size": len(data),
            })

    if not saved_files:
        return web.json_response({"error": "No files received"}, status=400)

    return web.json_response({"files": saved_files})


async def handle_context_files(request: web.Request) -> web.Response:
    """List all files in the context directory."""
    if not CONTEXT_DIR.exists():
        return web.json_response({"files": []})

    files = []
    for f in sorted(CONTEXT_DIR.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
        if f.is_file():
            stat = f.stat()
            files.append({
                "path": str(f),
                "name": f.name,
                "size": stat.st_size,
                "modified": stat.st_mtime,
            })
    return web.json_response({"files": files})


async def handle_catalog(request: web.Request) -> web.Response:
    """Return the full DreamNode catalog from the vault (id, title, type, path)."""
    nodes = discover_nodes()
    catalog = [
        {
            "id": n["uuid"],
            "title": n["title"],
            "type": n["type"],
            "repoPath": n["folder"],
            "path": n["path"],
        }
        for n in nodes
    ]
    return web.json_response({"nodes": catalog, "count": len(catalog)})


async def handle_spawn_terminal(request: web.Request) -> web.Response:
    """Open a Claude Code --continue session in a new Terminal window on macOS."""
    data = await request.json()
    cwd = data.get("cwd", str(AURYN_DIR))
    # Security: cwd must be inside the vault
    resolved = str(Path(cwd).resolve())
    if not resolved.startswith(str(VAULT_DIR)):
        return web.json_response({"error": "cwd outside vault"}, status=403)
    if not Path(resolved).is_dir():
        return web.json_response({"error": "cwd not found"}, status=404)

    # Open Terminal.app with claude --continue in the right directory
    script = f'''tell application "Terminal"
    activate
    do script "cd {resolved} && claude --continue"
end tell'''
    subprocess.Popen(["osascript", "-e", script])
    return web.json_response({"ok": True, "cwd": resolved})


async def handle_api_file(request: web.Request) -> web.Response:
    """Serve any file from the vault by relative path."""
    rel_path = request.query.get("path", "")
    if not rel_path:
        return web.json_response({"error": "path required"}, status=400)
    file_path = (VAULT_DIR / rel_path).resolve()
    # Security: must be inside vault
    if not str(file_path).startswith(str(VAULT_DIR)):
        return web.json_response({"error": "path outside vault"}, status=403)
    if not file_path.exists() or file_path.is_dir():
        return web.json_response({"error": "file not found"}, status=404)
    return web.FileResponse(file_path)


async def handle_readme(request: web.Request) -> web.Response:
    """Return README.md content for a DreamNode by absolute path."""
    dn_path = request.query.get("path", "")
    if not dn_path:
        return web.json_response({"error": "path required"}, status=400)
    readme_path = Path(dn_path) / "README.md"
    if not readme_path.exists():
        return web.json_response({"readme": "", "title": Path(dn_path).name})
    content = readme_path.read_text(encoding="utf-8", errors="replace")
    return web.json_response({"readme": content, "title": Path(dn_path).name})


# ============================================================
# Chat History Persistence
# ============================================================


async def handle_chat_save(request: web.Request) -> web.Response:
    """Save conversation to disk. Body: { messages: [...], threadId?: string }"""
    data = await request.json()
    messages = data.get("messages", [])
    thread_id = data.get("threadId", "current")

    CHATS_DIR.mkdir(exist_ok=True)
    chat_file = CHATS_DIR / f"{thread_id}.json"
    chat_file.write_text(json.dumps({
        "threadId": thread_id,
        "messages": messages,
        "savedAt": datetime.now().isoformat(),
    }, indent=2))

    return web.json_response({"ok": True, "path": str(chat_file)})


async def handle_chat_load(request: web.Request) -> web.Response:
    """Load the current conversation thread."""
    thread_id = request.query.get("threadId", "current")
    chat_file = CHATS_DIR / f"{thread_id}.json"

    if not chat_file.exists():
        return web.json_response({"messages": [], "threadId": thread_id})

    data = json.loads(chat_file.read_text())
    return web.json_response(data)


async def handle_chat_clear(request: web.Request) -> web.Response:
    """Clear the current thread (archives it with timestamp, starts fresh)."""
    global _last_cc_inject_index
    thread_id = (await request.json()).get("threadId", "current")
    chat_file = CHATS_DIR / f"{thread_id}.json"

    if chat_file.exists():
        # Archive with timestamp so history is never lost
        ts = datetime.now().strftime("%Y%m%d-%H%M%S")
        archive = CHATS_DIR / f"{thread_id}_{ts}.json"
        chat_file.rename(archive)

    # Reset delta injection counter for new chat session
    _last_cc_inject_index = 0

    return web.json_response({"ok": True, "archived": True})


async def handle_chat_list(request: web.Request) -> web.Response:
    """List all chat history files sorted by modification time (newest first)."""
    if not CHATS_DIR.exists():
        return web.json_response({"chats": []})

    chats = []
    for f in sorted(CHATS_DIR.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
        if f.is_file() and f.suffix == ".json":
            try:
                data = json.loads(f.read_text())
                messages = data.get("messages", [])
                # Get first user message as preview
                preview = ""
                for msg in messages:
                    if msg.get("role") == "user":
                        preview = msg.get("content", "")[:100]
                        break
                chats.append({
                    "threadId": data.get("threadId", f.stem),
                    "filename": f.name,
                    "savedAt": data.get("savedAt", ""),
                    "messageCount": len(messages),
                    "preview": preview,
                    "mtime": f.stat().st_mtime,
                })
            except (json.JSONDecodeError, OSError):
                continue

    return web.json_response({"chats": chats})


# ============================================================
# DreamTalk Thumbnail API
# ============================================================

async def handle_dreamtalk(request: web.Request) -> web.StreamResponse:
    """Serve a DreamNode's DreamTalk image by ID (UUID or folder name)."""
    node_id = request.match_info.get("id", "")
    if not node_id:
        raise web.HTTPNotFound()

    # Find the node
    node = _find_node(node_id)
    if not node:
        raise web.HTTPNotFound()

    node_path = Path(node["path"])
    udd_path = node_path / ".udd"
    if not udd_path.exists():
        raise web.HTTPNotFound()

    try:
        udd = json.loads(udd_path.read_text())
    except (json.JSONDecodeError, OSError):
        raise web.HTTPNotFound()

    dreamtalk = udd.get("dreamTalk", "")
    if not dreamtalk:
        raise web.HTTPNotFound()

    image_path = node_path / dreamtalk
    if not image_path.is_file():
        raise web.HTTPNotFound()

    return web.FileResponse(image_path)


# ============================================================
# Network: Tailscale, SSL, IP detection
# ============================================================

def get_local_ip() -> str:
    """Get the local LAN IP address."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


def ensure_tailscale() -> str | None:
    """Ensure Tailscale is running. Returns Tailscale IP or None."""
    if not shutil.which("tailscale"):
        return None

    result = subprocess.run(
        ["tailscale", "ip", "-4"],
        capture_output=True, text=True, timeout=5,
    )
    if result.returncode == 0:
        ip = result.stdout.strip().split("\n")[0]
        print(f"[Tailscale] Connected: {ip}")
        return ip

    print("[Tailscale] Not connected, attempting 'tailscale up'...")
    result = subprocess.run(
        ["tailscale", "up"],
        capture_output=True, text=True, timeout=30,
    )
    if result.returncode != 0:
        print(f"[Tailscale] Failed: {result.stderr.strip()}")
        print("[Tailscale] Run 'sudo brew services start tailscale' manually if needed")
        return None

    result = subprocess.run(
        ["tailscale", "ip", "-4"],
        capture_output=True, text=True, timeout=5,
    )
    if result.returncode == 0:
        ip = result.stdout.strip().split("\n")[0]
        print(f"[Tailscale] Connected: {ip}")
        return ip
    return None


def get_or_create_ssl_context(local_ip: str, tailscale_ip: str | None) -> ssl.SSLContext | None:
    """Generate self-signed cert with SANs for all access IPs."""
    cert_file = AURYN_DIR / "cert.pem"
    key_file = AURYN_DIR / "key.pem"

    sans = [f"IP:127.0.0.1", f"IP:{local_ip}", "DNS:localhost"]
    if tailscale_ip:
        sans.append(f"IP:{tailscale_ip}")

    regen = False
    if not cert_file.exists() or not key_file.exists():
        regen = True
    else:
        try:
            result = subprocess.run(
                ["openssl", "x509", "-in", str(cert_file), "-noout", "-text"],
                capture_output=True, text=True,
            )
            cert_text = result.stdout
            if tailscale_ip and tailscale_ip not in cert_text:
                regen = True
            if local_ip not in cert_text:
                regen = True
        except Exception:
            regen = True

    if regen:
        san_str = ",".join(sans)
        try:
            subprocess.run([
                "openssl", "req", "-x509", "-newkey", "rsa:2048",
                "-keyout", str(key_file), "-out", str(cert_file),
                "-days", "365", "-nodes",
                "-subj", "/CN=AURYN",
                "-addext", f"subjectAltName={san_str}",
            ], check=True, capture_output=True)
            print(f"[SSL] Generated certificate (SANs: {san_str})")
        except (subprocess.CalledProcessError, FileNotFoundError) as e:
            print(f"[SSL] Could not generate certificate: {e}")
            return None

    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(str(cert_file), str(key_file))
    return ctx


async def handle_install_cert(request: web.Request) -> web.Response:
    """Serve the CA cert for iOS installation."""
    cert_file = AURYN_DIR / "cert.pem"
    if not cert_file.exists():
        raise web.HTTPNotFound()
    return web.Response(
        body=cert_file.read_bytes(),
        content_type="application/x-x509-ca-cert",
        headers={"Content-Disposition": "attachment; filename=auryn-ca.pem"},
    )


# ============================================================
# CLI & App setup
# ============================================================

async def check_ollama(url: str) -> bool:
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(url, timeout=aiohttp.ClientTimeout(total=3)) as resp:
                return resp.status == 200
    except Exception:
        return False


def load_interbrain_api_key() -> str:
    """Load Claude API key from InterBrain's Obsidian plugin settings."""
    paths = [
        Path.home() / "RealDealVault" / ".obsidian" / "plugins" / "interbrain" / "data.json",
    ]
    for p in paths:
        if p.exists():
            try:
                data = json.loads(p.read_text())
                key = data.get("claudeApiKey", "")
                if key:
                    print(f"[Claude] API key loaded from InterBrain settings")
                    return key
            except Exception:
                pass
    key = os.environ.get("ANTHROPIC_API_KEY", "")
    if key:
        print("[Claude] API key loaded from ANTHROPIC_API_KEY env var")
    return key


def get_ollama_models(ollama_url: str) -> list[str]:
    """Fetch available Ollama model names."""
    import urllib.request
    try:
        with urllib.request.urlopen(f"{ollama_url}/api/tags", timeout=3) as resp:
            data = json.loads(resp.read())
            return [m["name"] for m in data.get("models", [])
                    if not m["name"].startswith("nomic")]
    except Exception:
        return []


# ============================================================
# Knowledge Gardening — route insights to DreamNode READMEs
# ============================================================

GARDEN_SYSTEM_PROMPT = """You are AURYN's knowledge gardener. Your job: read a conversation and its loaded DreamNode context, then surgically update the relevant READMEs with new insights.

RULES:
- Only add genuinely new insights not already present in the README
- Be surgical — edit specific sections, don't rewrite entire files
- Preserve the existing voice and style of each README
- If a README has no relevant section for the insight, add a minimal new section
- Signal over noise: concrete insights, structural decisions, distilled wisdom. NOT stream of consciousness or redundant reformulations
- Output ONLY valid JSON — no markdown fences, no commentary before or after

OUTPUT FORMAT — a JSON array of edits:
[
  {
    "dreamnode": "Title of DreamNode",
    "path": "/absolute/path/to/README.md",
    "reason": "Brief explanation of what insight is being added",
    "edits": [
      {
        "old": "exact existing text to find and replace",
        "new": "the replacement text with the new insight woven in"
      }
    ]
  }
]

If no edits are needed, return an empty array: []

Each "old" string must be an EXACT substring of the current README content. Keep edits minimal — include just enough surrounding context in "old" to uniquely identify the location."""


async def _ai_bridge_inference(messages: list[dict], port: int = 27182) -> str:
    """Send an inference request to the AI bridge WebSocket and collect the full response.

    Uses raw sockets because the InterBrain's WebSocket server computes
    Sec-WebSocket-Accept incorrectly — browsers don't care, but Python
    WebSocket libraries reject the handshake. Raw TCP bypasses this.
    """
    import base64 as b64

    request_id = str(uuid.uuid4())
    chunks: list[str] = []

    reader, writer = await asyncio.open_connection("localhost", port)

    # WebSocket handshake
    ws_key = b64.b64encode(os.urandom(16)).decode()
    handshake = (
        "GET / HTTP/1.1\r\n"
        "Host: localhost:{}\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        "Sec-WebSocket-Key: {}\r\n"
        "Sec-WebSocket-Version: 13\r\n"
        "\r\n"
    ).format(port, ws_key)
    writer.write(handshake.encode())
    await writer.drain()

    # Read handshake response (skip validation of Sec-WebSocket-Accept)
    resp = b""
    while b"\r\n\r\n" not in resp:
        resp += await reader.read(4096)
    if b"101" not in resp:
        writer.close()
        raise RuntimeError(f"AI bridge handshake failed: {resp[:200].decode()}")

    # Any data after the headers is the start of the first frame
    after_headers = resp.split(b"\r\n\r\n", 1)[1]
    buffer = bytearray(after_headers)

    async def _read_frame() -> str:
        """Read one WebSocket text frame."""
        nonlocal buffer
        # Ensure we have at least 2 bytes for the header
        while len(buffer) < 2:
            buffer.extend(await reader.read(4096))

        b0, b1 = buffer[0], buffer[1]
        masked = bool(b1 & 0x80)
        length = b1 & 0x7F
        offset = 2

        if length == 126:
            while len(buffer) < 4:
                buffer.extend(await reader.read(4096))
            length = struct.unpack(">H", buffer[2:4])[0]
            offset = 4
        elif length == 127:
            while len(buffer) < 10:
                buffer.extend(await reader.read(4096))
            length = struct.unpack(">Q", buffer[2:10])[0]
            offset = 10

        if masked:
            offset += 4  # skip mask key (server shouldn't mask, but just in case)

        total = offset + length
        while len(buffer) < total:
            buffer.extend(await reader.read(4096))

        payload = buffer[offset:total]
        if masked:
            mask = buffer[offset - 4:offset]
            payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))

        buffer = buffer[total:]
        return payload.decode("utf-8", errors="replace")

    def _make_frame(text: str) -> bytes:
        """Create a masked WebSocket text frame (client must mask)."""
        payload = text.encode("utf-8")
        frame = bytearray()
        frame.append(0x81)  # FIN + text opcode

        mask_key = os.urandom(4)
        length = len(payload)
        if length < 126:
            frame.append(0x80 | length)  # masked
        elif length < 65536:
            frame.append(0x80 | 126)
            frame.extend(struct.pack(">H", length))
        else:
            frame.append(0x80 | 127)
            frame.extend(struct.pack(">Q", length))

        frame.extend(mask_key)
        frame.extend(bytes(b ^ mask_key[i % 4] for i, b in enumerate(payload)))
        return bytes(frame)

    try:
        # Wait for ai-bridge-ready
        ready_msg = await asyncio.wait_for(_read_frame(), timeout=10)
        data = json.loads(ready_msg)
        if data.get("type") != "ai-bridge-ready":
            raise RuntimeError(f"Expected ai-bridge-ready, got: {data}")

        # Send inference request
        req = json.dumps({
            "type": "ai-inference-stream-request",
            "requestId": request_id,
            "messages": messages,
            "complexity": "standard",
        })
        writer.write(_make_frame(req))
        await writer.drain()

        # Collect streamed response
        while True:
            raw = await asyncio.wait_for(_read_frame(), timeout=120)
            data = json.loads(raw)
            if data.get("requestId") != request_id:
                continue
            if data["type"] == "ai-inference-stream-chunk":
                chunks.append(data["chunk"])
            elif data["type"] == "ai-inference-stream-done":
                break
            elif data["type"] == "ai-inference-stream-error":
                raise RuntimeError(f"AI bridge error: {data.get('error')}")

    finally:
        writer.close()

    return "".join(chunks)


def _apply_garden_edits(edits: list[dict]) -> list[dict]:
    """Apply edits to README files. Returns list of results."""
    results = []
    for edit_group in edits:
        path = edit_group.get("path", "")
        title = edit_group.get("dreamnode", "")
        reason = edit_group.get("reason", "")

        if not path or not Path(path).exists():
            results.append({"dreamnode": title, "status": "error", "reason": f"File not found: {path}"})
            continue

        readme_path = Path(path)
        if readme_path.is_dir():
            readme_path = readme_path / "README.md"

        if not readme_path.exists():
            results.append({"dreamnode": title, "status": "error", "reason": f"README not found: {readme_path}"})
            continue

        content = readme_path.read_text(encoding="utf-8")
        modified = False

        for edit in edit_group.get("edits", []):
            old = edit.get("old", "")
            new = edit.get("new", "")
            if not old or old == new:
                continue
            if old in content:
                content = content.replace(old, new, 1)
                modified = True
            else:
                results.append({
                    "dreamnode": title, "status": "warning",
                    "reason": f"Could not find text to replace (skipped): {old[:60]}...",
                })

        if modified:
            readme_path.write_text(content, encoding="utf-8")
            # Git commit
            try:
                subprocess.run(
                    ["git", "add", str(readme_path)],
                    cwd=readme_path.parent, capture_output=True, timeout=10,
                )
                subprocess.run(
                    ["git", "commit", "-m", f"Garden: {reason}\n\nCo-Authored-By: AURYN <auryn@dreamos.local>"],
                    cwd=readme_path.parent, capture_output=True, timeout=10,
                )
            except Exception as e:
                print(f"[Garden] Git commit failed for {title}: {e}")

            results.append({"dreamnode": title, "status": "ok", "reason": reason})

    return results


async def ws_garden(request: web.Request) -> web.WebSocketResponse:
    """WebSocket endpoint for knowledge gardening.

    Expects a message: {
        type: "garden",
        conversation: [{role, content}, ...],
        context: [{title, id, path}, ...]
    }

    Reads READMEs for each context node, sends everything to AI bridge,
    applies returned edits, reports results.
    """
    ws = web.WebSocketResponse()
    await ws.prepare(request)

    async for msg in ws:
        if msg.type != aiohttp.WSMsgType.TEXT:
            continue
        try:
            data = json.loads(msg.data)
        except json.JSONDecodeError:
            continue

        if data.get("type") != "garden":
            continue

        conversation = data.get("conversation", [])
        context_nodes = data.get("context", [])

        if not conversation:
            await ws.send_json({"type": "garden_result", "status": "empty", "message": "No conversation to garden."})
            continue

        await ws.send_json({"type": "garden_status", "message": "Reading DreamNode context..."})

        # Build context block with READMEs
        context_block = ""
        for node in context_nodes:
            path = node.get("path", "")
            title = node.get("title", "")
            node_id = node.get("id", "")
            readme_path = Path(path) / "README.md" if path else None

            if readme_path and readme_path.exists():
                readme_content = readme_path.read_text(encoding="utf-8")
                context_block += f"\n\n---\n### DreamNode: {title}\n- ID: {node_id}\n- Path: {path}\n- README path: {readme_path}\n\n{readme_content}"
            else:
                context_block += f"\n\n---\n### DreamNode: {title}\n- ID: {node_id}\n- Path: {path}\n- README: (not found)\n"

        # Build the messages for the AI bridge
        garden_messages = [
            {"role": "system", "content": GARDEN_SYSTEM_PROMPT},
            {"role": "user", "content": f"""Here is the loaded DreamNode context (these are the READMEs you may edit):

{context_block}

---

Here is the conversation to extract insights from:

{json.dumps(conversation, indent=2)}

Analyze the conversation. For each DreamNode whose README should be updated with new insights from this conversation, produce the surgical edits. Return ONLY the JSON array."""},
        ]

        await ws.send_json({"type": "garden_status", "message": "Routing insights..."})

        try:
            response = await _ai_bridge_inference(garden_messages)

            # Parse the JSON response — strip markdown fences if present
            cleaned = response.strip()
            if cleaned.startswith("```"):
                cleaned = re.sub(r"^```\w*\n?", "", cleaned)
                cleaned = re.sub(r"\n?```$", "", cleaned)
                cleaned = cleaned.strip()

            edits = json.loads(cleaned)

            if not edits:
                await ws.send_json({
                    "type": "garden_result", "status": "no_changes",
                    "message": "No new insights to route — READMEs are up to date.",
                })
                continue

            await ws.send_json({"type": "garden_status", "message": f"Applying {len(edits)} edit(s)..."})

            results = _apply_garden_edits(edits)
            await ws.send_json({
                "type": "garden_result", "status": "done",
                "edits": results,
                "message": f"Gardened {sum(1 for r in results if r['status'] == 'ok')} DreamNode(s).",
            })

        except json.JSONDecodeError as e:
            await ws.send_json({
                "type": "garden_result", "status": "error",
                "message": f"Failed to parse AI response as JSON: {e}\n\nRaw response:\n{response[:500]}",
            })
        except Exception as e:
            await ws.send_json({
                "type": "garden_result", "status": "error",
                "message": f"Garden error: {e}",
            })

    return ws


# ============================================================
# Claude Code Sub-Agent
# ============================================================

# Registry of active Claude Code subprocesses — keyed by asyncio task id
_active_cc_procs: dict[int, asyncio.subprocess.Process] = {}


def _kill_all_cc_procs():
    """Kill all active Claude Code subprocesses."""
    for proc in list(_active_cc_procs.values()):
        try:
            proc.terminate()
        except ProcessLookupError:
            pass
    _active_cc_procs.clear()


async def run_claude_code(
    prompt: str,
    model: str = "sonnet",
    max_budget: float = 5.00,
    cwd: str | None = None,
    allowed_tools: str | None = None,
) -> dict:
    """Run Claude Code in headless mode, collect final result only.

    For streaming, use run_claude_code_streaming() instead.
    """
    result_holder: dict = {}
    async for event in run_claude_code_streaming(
        prompt=prompt, model=model, max_budget=max_budget,
        cwd=cwd, allowed_tools=allowed_tools,
    ):
        if event.get("type") == "result":
            result_holder = event
    return result_holder or {"type": "result", "is_error": True, "result": "(no output)"}


async def run_claude_code_streaming(
    prompt: str,
    model: str = "sonnet",
    max_budget: float = 5.00,
    cwd: str | None = None,
    allowed_tools: str | None = None,
):
    """Run Claude Code as a sub-agent in headless streaming mode.

    Always uses --continue to resume the most recent session in the cwd.
    The working directory IS the session key — each DreamNode gets its own thread.
    Yields parsed JSON events as they arrive from stream-json output.
    """
    cmd = [
        "claude", "-p",
        "--output-format", "stream-json",
        "--dangerously-skip-permissions",
        "--model", model,
        "--max-budget-usd", str(max_budget),
        "--continue",
    ]

    if allowed_tools:
        for tool in allowed_tools.split():
            cmd.extend(["--allowedTools", tool])

    env = os.environ.copy()
    env.pop("CLAUDECODE", None)  # Allow nested sessions

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=cwd or str(AURYN_DIR),
        env=env,
    )

    # Register so it can be killed on session cancel/disconnect
    task_id = id(asyncio.current_task())
    _active_cc_procs[task_id] = proc

    try:
        # Send prompt via stdin and close it
        proc.stdin.write(prompt.encode("utf-8"))
        await proc.stdin.drain()
        proc.stdin.close()

        # Read stdout line by line — each line is a JSON event
        buffer = b""
        while True:
            chunk = await proc.stdout.read(4096)
            if not chunk:
                break
            buffer += chunk
            while b"\n" in buffer:
                line, buffer = buffer.split(b"\n", 1)
                line = line.strip()
                if not line:
                    continue
                try:
                    event = json.loads(line.decode("utf-8", errors="replace"))
                    yield event
                except json.JSONDecodeError:
                    continue

        # Process any remaining buffer
        if buffer.strip():
            try:
                event = json.loads(buffer.decode("utf-8", errors="replace"))
                yield event
            except json.JSONDecodeError:
                pass

        await proc.wait()
    except asyncio.CancelledError:
        # Session was cancelled — kill the subprocess
        try:
            proc.terminate()
            await asyncio.wait_for(proc.wait(), timeout=3)
        except (ProcessLookupError, asyncio.TimeoutError):
            try:
                proc.kill()
            except ProcessLookupError:
                pass
        raise
    finally:
        _active_cc_procs.pop(task_id, None)


# ============================================================
# Server Reload
# ============================================================

async def handle_reload(request: web.Request) -> web.Response:
    """Restart the AURYN server process to pick up code changes.

    Spawns a detached shell that waits for this process to die,
    then starts a fresh server with the same args.
    """
    import sys

    async def _do_restart():
        await asyncio.sleep(0.3)  # Let the HTTP response send
        pid = os.getpid()
        cmd_args = " ".join(sys.argv[1:])
        script = f'while kill -0 {pid} 2>/dev/null; do sleep 0.2; done; cd "{AURYN_DIR}" && uv run auryn.py {cmd_args} &'
        subprocess.Popen(["bash", "-c", script], start_new_session=True)
        os._exit(0)

    asyncio.create_task(_do_restart())
    return web.Response(text="Restarting...", content_type="text/plain")


# ============================================================
# Claude Code WebSocket — /do command handler
# ============================================================

async def ws_claude(request: web.Request) -> web.WebSocketResponse:
    """WebSocket endpoint for Claude Code sub-agent.

    Expects: {
        type: "claude_code",
        prompt: "what to do",
        context: [{title, id, path}, ...],
        conversation: [{role, content}, ...]
    }

    Spawns Claude Code in headless mode, streams status back.
    Supports session continuity via resume.
    """
    ws = web.WebSocketResponse()
    await ws.prepare(request)

    async for msg in ws:
        if msg.type != aiohttp.WSMsgType.TEXT:
            continue
        try:
            data = json.loads(msg.data)
        except json.JSONDecodeError:
            continue

        if data.get("type") != "claude_code":
            continue

        prompt = data.get("prompt", "")
        context_nodes = data.get("context", [])
        conversation = data.get("conversation", [])

        if not prompt:
            await ws.send_json({"type": "claude_status", "message": "No prompt provided."})
            continue

        # Build context for Claude Code
        context_parts = []
        for node in context_nodes:
            path = node.get("path", "")
            title = node.get("title", "")
            readme_path = Path(path) / "README.md" if path and Path(path).is_dir() else None
            if readme_path and readme_path.exists():
                content = readme_path.read_text(encoding="utf-8")
                context_parts.append(f"## DreamNode: {title}\nPath: {path}\n\n{content}")

        # Include recent conversation for context
        conv_text = ""
        if conversation:
            recent = conversation[-10:]  # last 10 messages
            conv_text = "\n".join(f"[{m['role']}]: {m['content']}" for m in recent)

        full_prompt = prompt
        if context_parts:
            full_prompt = (
                "Context — these DreamNodes are relevant:\n\n"
                + "\n\n---\n\n".join(context_parts)
                + "\n\n---\n\nRecent conversation:\n" + conv_text
                + "\n\n---\n\nTask: " + prompt
            )

        await ws.send_json({"type": "claude_prompt", "prompt": full_prompt})
        await ws.send_json({"type": "claude_status", "message": f"Spawning Claude Code..."})

        try:
            result = await run_claude_code(
                prompt=full_prompt,
                model="sonnet",
                max_budget=1.00,
                cwd=str(AURYN_DIR),
                allowed_tools="Bash Read Edit Write Grep Glob",
            )

            response_text = result.get("result", "")
            cost = result.get("total_cost_usd", 0)
            is_error = result.get("is_error", False)

            await ws.send_json({
                "type": "claude_result",
                "status": "error" if is_error else "done",
                "message": response_text,
                "cost": cost,
            })

        except Exception as e:
            await ws.send_json({
                "type": "claude_result",
                "status": "error",
                "message": str(e),
            })

    return ws


def create_app(
    host: str, port: int, model: str, ollama_url: str,
    claude_api_key: str = "", models: list[str] | None = None,
) -> web.Application:
    index_path = AURYN_DIR / "index.html"
    raw_html = index_path.read_text()
    injected_html = build_injected_index(raw_html, models=models)

    app = web.Application()
    app["injected_html"] = injected_html
    app["default_model"] = model
    app["ollama_url"] = ollama_url
    app["claude_api_key"] = claude_api_key

    app.router.add_get("/ws", ws_inference)
    app.router.add_get("/ws/transcribe", ws_transcribe)
    app.router.add_get("/ws/garden", ws_garden)
    app.router.add_get("/ws/claude", ws_claude)
    app.router.add_post("/upload", handle_upload)
    app.router.add_get("/context-files", handle_context_files)
    app.router.add_get("/catalog", handle_catalog)
    app.router.add_get("/readme", handle_readme)
    app.router.add_get("/api/file", handle_api_file)
    app.router.add_post("/api/spawn-terminal", handle_spawn_terminal)
    app.router.add_post("/chat/save", handle_chat_save)
    app.router.add_get("/chat/load", handle_chat_load)
    app.router.add_post("/chat/clear", handle_chat_clear)
    app.router.add_get("/chat/list", handle_chat_list)
    app.router.add_get("/api/dreamtalk/{id}", handle_dreamtalk)
    app.router.add_post("/reload", handle_reload)
    app.router.add_get("/install-cert", handle_install_cert)
    app.router.add_get("/", handle_index)
    app.router.add_get("/{path:.*}", handle_static)

    return app


async def serve(args: argparse.Namespace) -> None:
    # Clean up old context files on startup
    removed = _cleanup_context_dir()
    if removed:
        print(f"[Context] Cleaned {removed} file(s) older than {CONTEXT_MAX_AGE_DAYS} days")

    ollama_ok = await check_ollama(args.ollama_url)
    ollama_status = "\u2713" if ollama_ok else "\u2717 (not reachable)"

    local_ip = get_local_ip()
    tailscale_ip = ensure_tailscale()
    ssl_ctx = get_or_create_ssl_context(local_ip, tailscale_ip)
    protocol = "https" if ssl_ctx else "http"
    ws_protocol = "wss" if ssl_ctx else "ws"

    print(f"\nAURYN serving at {protocol}://{args.host}:{args.port}")
    print(f"  Local:     {protocol}://localhost:{args.port}")
    print(f"  LAN:       {protocol}://{local_ip}:{args.port}")
    if tailscale_ip:
        print(f"  Tailscale: {protocol}://{tailscale_ip}:{args.port}")
    print(f"  WebSocket: {ws_protocol}://{args.host}:{args.port}/ws")
    print(f"  Ollama:    {args.ollama_url} {ollama_status}")
    if ssl_ctx:
        print(f"  SSL:       Self-signed certificate")
        cert_url = f"{protocol}://{tailscale_ip or local_ip}:{args.port}/install-cert"
        print(f"  Install:   Open {cert_url} on iPhone")
        print(f"             Then: Settings > General > VPN & Device Management > Install")
        print(f"             Then: Settings > General > About > Certificate Trust Settings > Enable")
    claude_api_key = load_interbrain_api_key()

    ollama_models = get_ollama_models(args.ollama_url)
    claude_models = []
    if claude_api_key:
        claude_models = ["claude-sonnet-4-6", "claude-haiku-4-5-20251001"]
        print(f"  Claude:    {len(claude_models)} models available")
    else:
        print("  Claude:    No API key found")
    all_models = []
    if args.model not in ollama_models and args.model not in claude_models:
        all_models.append(args.model)
    all_models.extend(ollama_models)
    all_models.extend(claude_models)
    seen = set()
    models = []
    for m in all_models:
        if m not in seen:
            seen.add(m)
            models.append(m)

    print(f"  Recordings:  {RECORDINGS_DIR}/")
    print(f"  Transcripts: {TRANSCRIPTS_DIR}/")
    print()

    app = create_app(
        args.host, args.port, args.model, args.ollama_url,
        claude_api_key=claude_api_key, models=models,
    )
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, args.host, args.port, ssl_context=ssl_ctx)
    await site.start()

    try:
        await asyncio.Event().wait()
    except (KeyboardInterrupt, asyncio.CancelledError):
        pass
    finally:
        await runner.cleanup()


async def _run_garden_cli(args: argparse.Namespace) -> None:
    """CLI entry point for knowledge gardening."""
    import sys

    # Read conversation text
    if args.input:
        text = Path(args.input).read_text() if Path(args.input).exists() else args.input
    else:
        text = sys.stdin.read()

    if not text.strip():
        print("No input provided. Pipe conversation text or use --input.")
        return

    # Parse context nodes
    context_nodes = []
    for spec in (args.context or []):
        if ":" in spec:
            title, path = spec.split(":", 1)
            context_nodes.append({"title": title, "id": "", "path": path})
        else:
            context_nodes.append({"title": spec, "id": "", "path": str(VAULT_DIR / spec)})

    # Build context block
    context_block = ""
    for node in context_nodes:
        path = node["path"]
        title = node["title"]
        readme_path = Path(path) / "README.md" if Path(path).is_dir() else Path(path)
        if readme_path.exists():
            content = readme_path.read_text(encoding="utf-8")
            context_block += f"\n\n---\n### DreamNode: {title}\n- Path: {path}\n- README path: {readme_path}\n\n{content}"

    messages = [
        {"role": "system", "content": GARDEN_SYSTEM_PROMPT},
        {"role": "user", "content": f"""DreamNode context:\n{context_block}\n\n---\n\nConversation:\n{text}\n\nProduce the JSON array of edits."""},
    ]

    print("[Garden] Sending to AI bridge...")
    try:
        response = await _ai_bridge_inference(messages)
        cleaned = response.strip()
        if cleaned.startswith("```"):
            cleaned = re.sub(r"^```\w*\n?", "", cleaned)
            cleaned = re.sub(r"\n?```$", "", cleaned)
            cleaned = cleaned.strip()

        edits = json.loads(cleaned)
        if not edits:
            print("[Garden] No edits needed — READMEs are up to date.")
            return

        print(f"[Garden] Applying {len(edits)} edit group(s)...")
        results = _apply_garden_edits(edits)
        for r in results:
            status = r["status"].upper()
            print(f"  [{status}] {r['dreamnode']}: {r['reason']}")

    except Exception as e:
        print(f"[Garden] Error: {e}")


async def _run_claude_cli(args: argparse.Namespace) -> None:
    """CLI entry point for Claude Code sub-agent."""
    # Resolve DreamNode ID to cwd
    cwd = None
    if args.id:
        node = _find_node(args.id)
        if node:
            cwd = node["path"]
        else:
            print(f"DreamNode not found: {args.id}")
            return
    result = await run_claude_code(
        prompt=args.prompt,
        model=args.model,
        max_budget=args.budget,
        cwd=cwd,
    )

    if result.get("is_error"):
        print(f"Error: {result.get('result', 'Unknown error')}")
    else:
        print(result.get("result", json.dumps(result, indent=2)))

    if result.get("session_id"):
        print(f"\nSession ID: {result['session_id']}")
    if result.get("total_cost_usd"):
        print(f"Cost: ${result['total_cost_usd']:.4f}")


# ============================================================
# CLI Subcommands — read, write, create, pop-out, garden-state,
#                   reveal, publish, clip, search (alias)
# ============================================================


def _find_node(identifier: str) -> dict | None:
    """Find a DreamNode by UUID, title, or folder name (case-insensitive)."""
    nodes = discover_nodes()
    id_lower = identifier.lower()
    for node in nodes:
        if node["uuid"] == identifier:
            return node
        if node["title"].lower() == id_lower:
            return node
        if node["folder"].lower() == id_lower:
            return node
    return None


def _parse_udd(node_path: str) -> dict:
    """Read and return the .udd file contents for a node directory."""
    node_dir = Path(node_path)
    udd_path = node_dir / ".udd"
    if not udd_path.exists():
        return {}
    try:
        return json.loads(udd_path.read_text())
    except (json.JSONDecodeError, OSError):
        return {}


def _get_node_id(udd_data: dict) -> str:
    """Get node ID from .udd, supporting both 'id' and 'uuid' keys."""
    return udd_data.get("id", udd_data.get("uuid", ""))


def _file_tree(node_dir: Path, depth: int = 1) -> list[str]:
    """Return file tree entries 1 level deep."""
    entries = []
    try:
        for item in sorted(node_dir.iterdir()):
            name = item.name
            if name.startswith(".") and name not in (".udd",):
                continue
            prefix = "d " if item.is_dir() else "f "
            entries.append(prefix + name)
    except OSError:
        pass
    return entries


def _git_log_oneline(node_dir: Path, n: int = 5) -> list[str]:
    """Return last N git commits as oneline strings."""
    try:
        result = subprocess.run(
            ["git", "log", f"--oneline", f"-{n}"],
            cwd=str(node_dir), capture_output=True, text=True, timeout=5,
        )
        if result.returncode == 0:
            return [l for l in result.stdout.strip().split("\n") if l]
    except (subprocess.TimeoutExpired, OSError):
        pass
    return []


def _last_commit_timestamp(node_dir: Path) -> int:
    """Return unix timestamp of last commit, or 0."""
    try:
        result = subprocess.run(
            ["git", "log", "--format=%at", "-1"],
            cwd=str(node_dir), capture_output=True, text=True, timeout=5,
        )
        if result.returncode == 0 and result.stdout.strip():
            return int(result.stdout.strip())
    except (subprocess.TimeoutExpired, OSError, ValueError):
        pass
    return 0


def run_read(args: argparse.Namespace) -> None:
    """CLI: auryn read <identifier> [--deep]"""
    node = _find_node(args.identifier)
    if not node:
        print(f"DreamNode not found: {args.identifier}")
        return

    node_dir = Path(node["path"])
    udd = _parse_udd(node["path"])

    print(f"=== {node['title']} ===")
    print(f"ID:     {node['uuid']}")
    print(f"Type:   {node['type']}")
    print(f"Folder: {node['folder']}")
    print(f"Path:   {node['path']}")
    if node.get("radicle_id"):
        print(f"RID:    {node['radicle_id']}")
    if udd.get("dreamTalk"):
        print(f"DreamTalk: {udd['dreamTalk']}")

    # Submodules/supermodules from .udd
    if udd.get("submodules"):
        print(f"\nSubmodules: {json.dumps(udd['submodules'], indent=2)}")
    if udd.get("supermodules"):
        print(f"\nSupermodules: {json.dumps(udd['supermodules'], indent=2)}")

    # README
    print("\n--- README.md ---")
    if node["readme"]:
        print(node["readme"])
    else:
        print("(no README)")

    # File tree
    print("\n--- File Tree (1 level) ---")
    for entry in _file_tree(node_dir):
        print(f"  {entry}")

    # Git log
    print("\n--- Recent Commits ---")
    commits = _git_log_oneline(node_dir)
    if commits:
        for c in commits:
            print(f"  {c}")
    else:
        print("  (no commits)")

    # Deep mode: read key files
    if getattr(args, "deep", False):
        print("\n--- Deep Read ---")
        read_files = []
        for f in sorted(node_dir.iterdir()):
            if f.name == "README.md":
                continue  # already shown
            if f.is_file() and (f.suffix == ".md" or f.name == "package.json"):
                read_files.append(f)
            if len(read_files) >= 5:
                break
        for f in read_files:
            print(f"\n--- {f.name} ---")
            try:
                content = f.read_text(errors="replace")
                # Truncate very long files
                if len(content) > 5000:
                    content = content[:5000] + "\n... (truncated)"
                print(content)
            except OSError as e:
                print(f"  (error reading: {e})")


def _extract_dreamnode_refs(readme_text: str) -> set[str]:
    """Extract all dreamnode:// UUIDs from README text."""
    return set(re.findall(r'dreamnode://([0-9a-f-]{36})', readme_text))


def _sync_submodules_from_readme(node_dir: Path, udd_data: dict) -> None:
    """
    Compare dreamnode:// references in README to current submodules.
    Add missing submodules, remove stale ones. Update .udd.
    """
    readme_path = node_dir / "README.md"
    if not readme_path.exists():
        return

    readme_text = readme_path.read_text(errors="replace")
    referenced_ids = _extract_dreamnode_refs(readme_text)

    if not referenced_ids:
        return

    # Build lookup of all vault DreamNodes by UUID
    all_nodes = discover_nodes()
    id_to_node = {n["uuid"]: n for n in all_nodes}

    # Get current submodule paths
    current_submodules = set()
    try:
        result = subprocess.run(
            ["git", "submodule", "status"],
            cwd=str(node_dir), capture_output=True, text=True, timeout=10,
        )
        if result.returncode == 0:
            for line in result.stdout.strip().split("\n"):
                if line.strip():
                    # Format: " <hash> <path> (<desc>)" or "-<hash> <path>"
                    parts = line.strip().lstrip("-+ ").split()
                    if len(parts) >= 2:
                        current_submodules.add(parts[1])
    except (subprocess.TimeoutExpired, OSError):
        pass

    # Map current submodule folder names to referenced IDs
    current_sub_folders = {Path(s).name for s in current_submodules}

    # Add new submodules for referenced DreamNodes not yet added
    for ref_id in referenced_ids:
        ref_node = id_to_node.get(ref_id)
        if not ref_node:
            print(f"  [warn] Referenced dreamnode://{ref_id} not found in vault")
            continue
        ref_folder = ref_node["folder"]
        if ref_folder in current_sub_folders:
            continue  # already a submodule

        sovereign_path = Path(ref_node["path"])
        if not sovereign_path.exists():
            continue

        print(f"  [submodule] Adding {ref_node['title']} ({ref_folder})")
        try:
            subprocess.run(
                ["git", "submodule", "add", str(sovereign_path), ref_folder],
                cwd=str(node_dir), capture_output=True, text=True, timeout=30,
            )
        except (subprocess.TimeoutExpired, OSError) as e:
            print(f"  [error] Failed to add submodule {ref_folder}: {e}")

    # Update .udd submodules list with radicle IDs of referenced nodes
    sub_rids = []
    for ref_id in referenced_ids:
        ref_node = id_to_node.get(ref_id)
        if ref_node and ref_node.get("radicle_id"):
            sub_rids.append(ref_node["radicle_id"])
    if sub_rids:
        udd_data["submodules"] = sorted(set(sub_rids))

    # Write updated .udd
    udd_path = node_dir / ".udd"
    udd_path.write_text(json.dumps(udd_data, indent=2) + "\n")


def run_write(args: argparse.Namespace) -> None:
    """CLI: auryn write <identifier> --old <text> --new <text> --message <msg>"""
    node = _find_node(args.identifier)
    if not node:
        print(f"DreamNode not found: {args.identifier}")
        return

    node_dir = Path(node["path"])
    readme_path = node_dir / "README.md"

    if not readme_path.exists():
        print(f"No README.md found at {readme_path}")
        return

    content = readme_path.read_text(errors="replace")

    if args.old not in content:
        print(f"Error: old_text not found in README.md")
        print(f"Searched for: {args.old[:200]}")
        return

    # Count occurrences to warn about ambiguity
    count = content.count(args.old)
    if count > 1:
        print(f"Warning: old_text appears {count} times — replacing first occurrence only")

    new_content = content.replace(args.old, args.new, 1)
    readme_path.write_text(new_content)
    print(f"README.md updated in {node['folder']}")

    # Sync submodules from dreamnode:// references
    udd_data = _parse_udd(node["path"])
    _sync_submodules_from_readme(node_dir, udd_data)

    # Auto-commit
    commit_msg = getattr(args, "message", None) or f"Update README: {node['title']}"
    try:
        subprocess.run(["git", "add", "-A"], cwd=str(node_dir), capture_output=True, timeout=10)
        subprocess.run(
            ["git", "commit", "-m", commit_msg],
            cwd=str(node_dir), capture_output=True, text=True, timeout=10,
        )
        print(f"Committed: {commit_msg}")
    except (subprocess.TimeoutExpired, OSError) as e:
        print(f"Warning: git commit failed: {e}")


def _to_pascal_case(title: str) -> str:
    """Convert a title to PascalCase folder name.
    'Test Node' -> 'TestNode', 'my cool thing' -> 'MyCoolThing'
    Already-PascalCase input is preserved: 'TestNode' -> 'TestNode'
    """
    # Remove non-alphanumeric except spaces and hyphens
    cleaned = re.sub(r"[^\w\s-]", "", title)
    # Split on spaces, hyphens, underscores
    words = re.split(r"[\s_-]+", cleaned)
    return "".join(w[0].upper() + w[1:] if w else "" for w in words)


def run_create(args: argparse.Namespace) -> str | None:
    """CLI: auryn create <title> [--readme <content>]. Returns new UUID or None."""
    title = args.title
    folder_name = _to_pascal_case(title)
    node_dir = VAULT_DIR / folder_name

    if node_dir.exists():
        print(f"Error: Directory already exists: {node_dir}")
        return None

    readme_content = getattr(args, "readme", None) or f"# {title}\n"
    new_id = str(uuid.uuid4())

    # Create directory
    node_dir.mkdir(parents=True)

    # git init
    subprocess.run(["git", "init"], cwd=str(node_dir), capture_output=True, timeout=10)

    # Write .udd
    udd_data = {
        "uuid": new_id,
        "title": title,
        "type": "dream",
    }
    (node_dir / ".udd").write_text(json.dumps(udd_data, indent=2) + "\n")

    # Write README.md
    if not readme_content.startswith("#"):
        readme_content = f"# {title}\n\n{readme_content}"
    (node_dir / "README.md").write_text(readme_content)

    # Copy LICENSE from AURYN template if exists
    auryn_license = AURYN_DIR / "LICENSE"
    if auryn_license.exists():
        shutil.copy2(str(auryn_license), str(node_dir / "LICENSE"))

    # Initial commit
    subprocess.run(["git", "add", "-A"], cwd=str(node_dir), capture_output=True, timeout=10)
    subprocess.run(
        ["git", "commit", "-m", f"Plant seed: {title}"],
        cwd=str(node_dir), capture_output=True, text=True, timeout=10,
    )

    print(f"Created DreamNode: {title}")
    print(f"  ID:     {new_id}")
    print(f"  Folder: {folder_name}")
    print(f"  Path:   {node_dir}")
    return new_id


def run_pop_out(args: argparse.Namespace) -> None:
    """CLI: auryn pop-out <parent_id> --title <name> --readme <content> --old <text> --new <text>"""
    # Find parent
    parent_node = _find_node(args.parent_id)
    if not parent_node:
        print(f"Parent DreamNode not found: {args.parent_id}")
        return

    # Create the new sovereign DreamNode
    create_ns = argparse.Namespace(title=args.title, readme=args.readme)
    new_id = run_create(create_ns)
    if not new_id:
        print("Failed to create new DreamNode")
        return

    # Now apply the diff to parent's README using write logic
    # The new_text should include a dreamnode:// reference so write's hook wires the submodule
    old_text = args.old
    new_text = args.new
    if f"dreamnode://{new_id}" not in new_text:
        # Auto-inject the reference if the user didn't include it
        new_text = new_text.replace("dreamnode://NEW_ID", f"dreamnode://{new_id}")

    write_ns = argparse.Namespace(
        identifier=args.parent_id,
        old=old_text,
        new=new_text,
        message=f"Pop out: {args.title} -> sovereign DreamNode",
    )
    run_write(write_ns)
    print(f"\nPop-out complete. New DreamNode ID: {new_id}")


def run_garden_state(args: argparse.Namespace) -> None:
    """CLI: auryn garden-state [--refresh]"""
    nodes = discover_nodes()
    now = time.time()

    # Categorize READMEs
    boilerplate = []
    shallow = []
    healthy = []

    # DreamNodes missing DreamTalk
    missing_dreamtalk = []

    # To-dos with optional dates
    todos: list[dict] = []

    # Broken references
    broken_refs: list[dict] = []

    # Recently active (top 10)
    node_activity: list[tuple[dict, int]] = []

    # Stale with open todos (>30 days)
    stale_with_todos: list[dict] = []

    # Build ID lookup for reference checking
    all_ids = {n["uuid"] for n in nodes}

    for node in nodes:
        node_dir = Path(node["path"])
        readme = node["readme"]
        udd = _parse_udd(node["path"])

        # Classify README
        meaningful_lines = [
            l for l in readme.split("\n")
            if l.strip() and not l.strip().startswith("#") and len(l.strip()) > 10
        ]
        if len(meaningful_lines) < 3:
            boilerplate.append(node)
        elif len(meaningful_lines) < 10:
            shallow.append(node)
        else:
            healthy.append(node)

        # DreamTalk check
        if not udd.get("dreamTalk"):
            missing_dreamtalk.append(node)

        # To-do extraction
        for line in readme.split("\n"):
            match = re.match(r'\s*-\s*\[\s*\]\s*(.*)', line)
            if match:
                todo_text = match.group(1).strip()
                # Try to find a date in the todo
                date_match = re.search(r'(\d{4}-\d{2}-\d{2})', todo_text)
                todos.append({
                    "dreamnode": node["title"],
                    "folder": node["folder"],
                    "todo": todo_text,
                    "date": date_match.group(1) if date_match else None,
                })

        # Broken dreamnode:// references
        refs = _extract_dreamnode_refs(readme)
        for ref_id in refs:
            if ref_id not in all_ids:
                broken_refs.append({
                    "dreamnode": node["title"],
                    "folder": node["folder"],
                    "broken_ref": ref_id,
                })

        # Activity timestamp
        ts = _last_commit_timestamp(node_dir)
        node_activity.append((node, ts))

    # Sort by recency
    node_activity.sort(key=lambda x: x[1], reverse=True)
    recently_active = node_activity[:10]

    # Stale with open todos (>30 days since last commit)
    thirty_days_ago = now - (30 * 86400)
    node_todos = {}
    for t in todos:
        node_todos.setdefault(t["folder"], []).append(t)

    for node, ts in node_activity:
        if ts > 0 and ts < thirty_days_ago and node["folder"] in node_todos:
            stale_with_todos.append({
                "dreamnode": node["title"],
                "folder": node["folder"],
                "last_commit": datetime.fromtimestamp(ts).strftime("%Y-%m-%d"),
                "open_todos": len(node_todos[node["folder"]]),
            })

    # Write garden-state.md
    output_path = AURYN_DIR / "garden-state.md"
    lines = [
        "# Garden State",
        "",
        "Auto-generated vault health report. Run `auryn garden-state --refresh` to regenerate.",
        f"Generated: {datetime.now().strftime('%Y-%m-%d %H:%M')}",
        f"Total DreamNodes: {len(nodes)}",
        "",
    ]

    # README health
    lines.append("## README Health")
    lines.append(f"- Healthy ({len(healthy)}): rich READMEs with 10+ meaningful lines")
    lines.append(f"- Shallow ({len(shallow)}): 3-9 meaningful lines")
    lines.append(f"- Boilerplate/Empty ({len(boilerplate)}): <3 meaningful lines")
    lines.append("")

    if boilerplate:
        lines.append("### Boilerplate/Empty READMEs")
        for n in sorted(boilerplate, key=lambda x: x["title"]):
            lines.append(f"- {n['title']} (`{n['folder']}`)")
        lines.append("")

    # Missing DreamTalk
    if missing_dreamtalk:
        lines.append(f"## Missing DreamTalk ({len(missing_dreamtalk)})")
        for n in sorted(missing_dreamtalk, key=lambda x: x["title"]):
            lines.append(f"- {n['title']} (`{n['folder']}`)")
        lines.append("")

    # Open To-dos
    if todos:
        lines.append(f"## Open To-dos ({len(todos)})")
        dated = [t for t in todos if t["date"]]
        undated = [t for t in todos if not t["date"]]
        if dated:
            lines.append("### With Dates")
            for t in sorted(dated, key=lambda x: x["date"]):
                lines.append(f"- [{t['date']}] {t['dreamnode']}: {t['todo']}")
        if undated:
            lines.append("### Undated")
            for t in sorted(undated, key=lambda x: x["dreamnode"]):
                lines.append(f"- {t['dreamnode']}: {t['todo']}")
        lines.append("")

    # Broken references
    if broken_refs:
        lines.append(f"## Broken References ({len(broken_refs)})")
        for r in broken_refs:
            lines.append(f"- {r['dreamnode']}: dreamnode://{r['broken_ref']}")
        lines.append("")

    # Recently active
    lines.append("## Recently Active (Top 10)")
    for node, ts in recently_active:
        if ts > 0:
            date_str = datetime.fromtimestamp(ts).strftime("%Y-%m-%d")
            lines.append(f"- {node['title']} (`{node['folder']}`) — {date_str}")
        else:
            lines.append(f"- {node['title']} (`{node['folder']}`) — no commits")
    lines.append("")

    # Stale with todos
    if stale_with_todos:
        lines.append(f"## Stale DreamNodes with Open To-dos ({len(stale_with_todos)})")
        for s in sorted(stale_with_todos, key=lambda x: x["last_commit"]):
            lines.append(f"- {s['dreamnode']} — last commit: {s['last_commit']}, {s['open_todos']} open to-do(s)")
        lines.append("")

    report = "\n".join(lines) + "\n"
    output_path.write_text(report)
    print(f"Garden state written to {output_path}")
    print(f"  {len(nodes)} DreamNodes: {len(healthy)} healthy, {len(shallow)} shallow, {len(boilerplate)} boilerplate")
    if broken_refs:
        print(f"  {len(broken_refs)} broken reference(s)")
    if missing_dreamtalk:
        print(f"  {len(missing_dreamtalk)} missing DreamTalk")


def run_reveal(args: argparse.Namespace) -> None:
    """CLI: auryn reveal <file_path>"""
    file_path = str(Path(args.file_path).resolve())
    output = json.dumps({"action": "reveal", "file_path": file_path})
    print(output)


def run_publish(args: argparse.Namespace) -> None:
    """CLI: auryn publish <id>"""
    node = _find_node(args.id)
    if not node:
        print(f"DreamNode not found: {args.id}")
        return

    node_dir = Path(node["path"])
    udd = _parse_udd(node["path"])

    if not udd.get("radicleId"):
        print(f"No Radicle ID — initialize with `rad init` first")
        print(f"  cd {node_dir} && rad init")
        return

    print(f"Publishing {node['title']} to Radicle...")
    try:
        result = subprocess.run(
            ["git", "push", "rad", "main"],
            cwd=str(node_dir), capture_output=True, text=True, timeout=30,
        )
        if result.returncode == 0:
            print(f"Published successfully")
            if result.stdout.strip():
                print(result.stdout.strip())
        else:
            print(f"Push failed: {result.stderr.strip()}")
    except (subprocess.TimeoutExpired, OSError) as e:
        print(f"Error: {e}")


def run_clip(args: argparse.Namespace) -> None:
    """CLI: auryn clip <id> --segments <json_ranges> --source <file>"""
    node = _find_node(args.id)
    if not node:
        print(f"DreamNode not found: {args.id}")
        return

    node_dir = Path(node["path"])
    songlines_dir = node_dir / "songlines"
    songlines_dir.mkdir(exist_ok=True)

    # Parse segments
    try:
        segments = json.loads(args.segments)
    except json.JSONDecodeError as e:
        print(f"Error parsing segments JSON: {e}")
        return

    # Create clip metadata
    clip_id = str(uuid.uuid4())[:8]
    clip_data = {
        "id": clip_id,
        "dreamnode": node["uuid"],
        "source": args.source,
        "segments": segments,
        "created_at": datetime.now().isoformat(),
    }

    clip_path = songlines_dir / f"clip-{clip_id}.json"
    clip_path.write_text(json.dumps(clip_data, indent=2) + "\n")

    # Commit
    try:
        subprocess.run(["git", "add", "-A"], cwd=str(node_dir), capture_output=True, timeout=10)
        subprocess.run(
            ["git", "commit", "-m", f"Add songline clip: {clip_id}"],
            cwd=str(node_dir), capture_output=True, text=True, timeout=10,
        )
        print(f"Clip saved: {clip_path}")
        print(f"  ID: {clip_id}")
        print(f"  Segments: {json.dumps(segments)}")
    except (subprocess.TimeoutExpired, OSError) as e:
        print(f"Warning: git commit failed: {e}")


def main() -> None:
    parser = argparse.ArgumentParser(description="AURYN self-serving server + context provider")
    sub = parser.add_subparsers(dest="command")

    # --- serve ---
    serve_parser = sub.add_parser("serve", help="Start the AURYN server")
    serve_parser.add_argument("--port", type=int, default=8080)
    serve_parser.add_argument("--host", default="0.0.0.0")
    serve_parser.add_argument("--model", default="claude-sonnet-4-6")
    serve_parser.add_argument("--ollama-url", default="http://localhost:11434")
    serve_parser.add_argument("--no-ssl", action="store_true", help="Disable HTTPS")
    serve_parser.add_argument("--transcription-model", default="base",
                              choices=["tiny", "base", "small", "medium", "large", "turbo"],
                              help="Whisper model size (tiny=fastest, turbo=best speed/quality)")

    # --- context ---
    ctx_parser = sub.add_parser("context", help="Fast context provider (Tier 1 + Tier 2)")
    ctx_parser.add_argument("input", help="Text string or path to file")
    ctx_parser.add_argument("--top", type=int, default=15, help="Max results (default: 15)")
    ctx_parser.add_argument("--json", dest="json_output", action="store_true",
                            help="Output as JSON")
    ctx_parser.add_argument("--rebuild", action="store_true",
                            help="Force rebuild index before searching")

    # --- index ---
    idx_parser = sub.add_parser("index", help="Build/rebuild the context index")
    idx_parser.add_argument("--force", action="store_true", help="Force rebuild")

    # --- garden ---
    garden_parser = sub.add_parser("garden", help="Knowledge garden: route insights to DreamNode READMEs")
    garden_parser.add_argument("--context", nargs="+", metavar="TITLE:PATH",
                               help="DreamNode context as title:path pairs")
    garden_parser.add_argument("--input", help="Conversation text or file path (default: stdin)")

    # --- cc (Claude Code sub-agent) ---
    cc_parser = sub.add_parser("cc", help="Delegate task to Claude Code sub-agent")
    cc_parser.add_argument("id", help="DreamNode ID to work in")
    cc_parser.add_argument("prompt", help="Prompt for Claude Code")
    cc_parser.add_argument("--model", default="sonnet", help="Model (default: sonnet)")
    cc_parser.add_argument("--budget", type=float, default=0.50, help="Max budget USD")

    # --- search (alias for context) ---
    search_parser = sub.add_parser("search", help="Search DreamNodes (alias for context)")
    search_parser.add_argument("input", help="Text string or path to file")
    search_parser.add_argument("--top", type=int, default=15, help="Max results (default: 15)")
    search_parser.add_argument("--json", dest="json_output", action="store_true",
                                help="Output as JSON")
    search_parser.add_argument("--rebuild", action="store_true",
                                help="Force rebuild index before searching")

    # --- read ---
    read_parser = sub.add_parser("read", help="Read a DreamNode by ID, title, or folder name")
    read_parser.add_argument("identifier", help="UUID, title, or folder name")
    read_parser.add_argument("--deep", action="store_true",
                              help="Also read key .md files and package.json")

    # --- write ---
    write_parser = sub.add_parser("write", help="Edit a DreamNode's README with string replacement")
    write_parser.add_argument("identifier", help="UUID, title, or folder name")
    write_parser.add_argument("--old", required=True, help="Text to replace")
    write_parser.add_argument("--new", required=True, help="Replacement text")
    write_parser.add_argument("--message", default=None, help="Commit message")

    # --- create ---
    create_parser = sub.add_parser("create", help="Create a new DreamNode")
    create_parser.add_argument("title", help="DreamNode title")
    create_parser.add_argument("--readme", default=None, help="README content")

    # --- pop-out ---
    popout_parser = sub.add_parser("pop-out", help="Pop out content to a new sovereign DreamNode")
    popout_parser.add_argument("parent_id", help="Parent DreamNode UUID, title, or folder")
    popout_parser.add_argument("--title", required=True, help="New DreamNode title")
    popout_parser.add_argument("--readme", required=True, help="README content for new node")
    popout_parser.add_argument("--old", required=True, help="Text to replace in parent README")
    popout_parser.add_argument("--new", required=True, help="Replacement text (include dreamnode://NEW_ID for auto-wiring)")

    # --- garden-state ---
    gs_parser = sub.add_parser("garden-state", help="Scan vault and write garden-state.md report")
    gs_parser.add_argument("--refresh", action="store_true", help="Force rescan")

    # --- reveal ---
    reveal_parser = sub.add_parser("reveal", help="Print file path as JSON for UI consumption")
    reveal_parser.add_argument("file_path", help="File path to reveal")

    # --- publish ---
    publish_parser = sub.add_parser("publish", help="Publish DreamNode to Radicle")
    publish_parser.add_argument("id", help="DreamNode UUID, title, or folder name")

    # --- clip ---
    clip_parser = sub.add_parser("clip", help="Create a songline clip in a DreamNode")
    clip_parser.add_argument("id", help="DreamNode UUID, title, or folder name")
    clip_parser.add_argument("--segments", required=True, help="JSON array of time ranges")
    clip_parser.add_argument("--source", required=True, help="Source file path")

    args = parser.parse_args()

    if args.command == "serve":
        if getattr(args, "no_ssl", False):
            global get_or_create_ssl_context
            get_or_create_ssl_context = lambda *a, **kw: None
        global _whisper_model_size, _whisper_repo
        _whisper_model_size = getattr(args, "transcription_model", "base")
        _whisper_repo = _MLX_WHISPER_MODELS.get(_whisper_model_size, _MLX_WHISPER_MODELS["base"])
        asyncio.run(serve(args))
    elif args.command == "context":
        run_context(args)
    elif args.command == "index":
        run_index(args)
    elif args.command == "garden":
        asyncio.run(_run_garden_cli(args))
    elif args.command == "cc":
        asyncio.run(_run_claude_cli(args))
    elif args.command == "search":
        run_context(args)
    elif args.command == "read":
        run_read(args)
    elif args.command == "write":
        run_write(args)
    elif args.command == "create":
        run_create(args)
    elif args.command == "pop-out":
        run_pop_out(args)
    elif args.command == "garden-state":
        run_garden_state(args)
    elif args.command == "reveal":
        run_reveal(args)
    elif args.command == "publish":
        run_publish(args)
    elif args.command == "clip":
        run_clip(args)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
