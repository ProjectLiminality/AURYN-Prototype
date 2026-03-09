# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "aiohttp>=3.9",
#     "mlx-whisper>=0.4",
#     "moonshine-voice>=0.0.49",
# ]
# ///
"""
AURYN self-serving server + fast context provider.

Usage:
    uv run aurin.py serve [--port 8080] [--host 0.0.0.0] [--model qwen3:32b]
    uv run aurin.py context <file_or_text> [--top N] [--json] [--rebuild]
    uv run aurin.py index [--force]
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
        "name": "search_dreamnodes",
        "description": (
            "Search the DreamNode knowledge garden using BM25 + vocabulary matching. "
            "Only use this when the user's question is about DreamNodes NOT already loaded as context petals. "
            "If relevant DreamNodes are already in context, use that information directly. "
            "Use this whenever the user asks about a topic, project, or concept that "
            "might exist in the vault, or when you need context before answering."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "The search query — keywords, concepts, or a natural language question.",
                },
                "top_k": {
                    "type": "integer",
                    "description": "Maximum number of results to return (default 8, max 20).",
                    "default": 8,
                },
                "include_readme": {
                    "type": "boolean",
                    "description": "If true, include the README content of each result (slower but richer).",
                    "default": False,
                },
            },
            "required": ["query"],
        },
    },
    {
        "name": "edit_readme",
        "description": (
            "Edit a DreamNode's README.md directly. Use this to route insights from conversation "
            "into the appropriate DreamNode README. The DreamNode must be loaded as a context petal. "
            "Provide the old text to replace and the new text. The edit is applied and auto-committed. "
            "For appending to a section, use old_text as the last line of the section and new_text "
            "as that line plus the new content. For rewriting a section, include the full section as old_text."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "dreamnode_path": {
                    "type": "string",
                    "description": "Absolute path to the DreamNode directory containing README.md.",
                },
                "old_text": {
                    "type": "string",
                    "description": "The exact text in the README to replace. Must match exactly (whitespace-sensitive).",
                },
                "new_text": {
                    "type": "string",
                    "description": "The replacement text. Must differ from old_text.",
                },
                "commit_message": {
                    "type": "string",
                    "description": "A concise commit message describing the insight being captured.",
                },
            },
            "required": ["dreamnode_path", "old_text", "new_text", "commit_message"],
        },
    },
    {
        "name": "run_claude_code",
        "description": (
            "Delegate a task to Claude Code — a powerful sub-agent with full filesystem access, "
            "bash execution, file editing, and deep codebase analysis. Use this for tasks that "
            "require reading/writing files, running commands, or deep technical work in a DreamNode. "
            "Claude Code runs autonomously and returns a complete result. "
            "Only use when the task genuinely requires file system access or execution. "
            "Sessions automatically continue per directory — Claude Code remembers previous work in each DreamNode."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "prompt": {
                    "type": "string",
                    "description": "The full task description for Claude Code to execute.",
                },
                "dreamnode_path": {
                    "type": "string",
                    "description": "Absolute path to the DreamNode directory to work in (optional — defaults to AURYN root).",
                },
            },
            "required": ["prompt"],
        },
    },
    {
        "name": "reveal_file",
        "description": (
            "Show a file to the user in the DreamSpace viewer. Use this to present "
            "the results of your work — images, PDFs, text files, HTML pages, or any "
            "file from the vault. The file opens fullscreen in the DreamSpace UI, and "
            "the containing DreamNode is selected. This is how AURYN presents artifacts "
            "to the user on their device."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "file_path": {
                    "type": "string",
                    "description": "Absolute path to the file to reveal (must be inside the vault).",
                },
            },
            "required": ["file_path"],
        },
    },
]


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
            return "No search index available. Run `aurin.py index` to build it."

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


async def _execute_run_claude_code(
    prompt: str,
    dreamnode_path: str | None = None,
    ws: "web.WebSocketResponse | None" = None,
    request_id: str = "",
) -> str:
    """Execute run_claude_code tool with streaming observability.

    If ws is provided, streams Claude Code activity events to the frontend.
    Uses delta injection: first call gets full chat history, subsequent calls
    get only messages since the last Claude Code invocation.
    """
    global _last_cc_inject_index
    try:
        is_auryn_local = not dreamnode_path or not Path(dreamnode_path).is_dir()
        cwd = str(AURYN_DIR) if is_auryn_local else dreamnode_path

        # In AURYN-local mode, inject chat history (full on first call, delta after)
        if is_auryn_local:
            all_messages = _load_chat_messages()
            if all_messages:
                if _last_cc_inject_index == 0:
                    # First invocation: full history
                    history = _format_messages_as_text(all_messages)
                    label = "AURYN CHAT HISTORY"
                else:
                    # Subsequent: only new messages since last call
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
            model="sonnet",
            max_budget=5.00,
            cwd=cwd,
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
            return f"**Claude Code** hit session budget limit (${cost:.2f} accumulated). The continued session has used its budget — clear chat or start a fresh task."

        prefix = "**Claude Code error:**\n" if is_error else f"**Claude Code result** (${cost:.4f}):\n"
        return prefix + (final_result or "(no output)")
    except Exception as e:
        return f"Claude Code execution error: {e}"


async def _dispatch_tool(
    tool_name: str,
    tool_input: dict,
    ws: "web.WebSocketResponse | None" = None,
    request_id: str = "",
) -> str:
    """Dispatch a tool call and return the result as a string."""
    if tool_name == "search_dreamnodes":
        return _execute_search_dreamnodes(
            query=tool_input.get("query", ""),
            top_k=tool_input.get("top_k", 8),
            include_readme=tool_input.get("include_readme", False),
        )
    elif tool_name == "edit_readme":
        return _execute_edit_readme(
            dreamnode_path=tool_input.get("dreamnode_path", ""),
            old_text=tool_input.get("old_text", ""),
            new_text=tool_input.get("new_text", ""),
            commit_message=tool_input.get("commit_message", "Update README"),
        )
    elif tool_name == "reveal_file":
        return _execute_reveal_file(
            file_path=tool_input.get("file_path", ""),
        )
    elif tool_name == "run_claude_code":
        return await _execute_run_claude_code(
            prompt=tool_input.get("prompt", ""),
            dreamnode_path=tool_input.get("dreamnode_path"),
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

    Implements an agentic loop: Claude can call search_dreamnodes and
    run_claude_code autonomously, then streams its final response.
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
                    # Include cwd for run_claude_code so frontend can offer "open in terminal"
                    if b["name"] == "run_claude_code":
                        dn_path = tool_input.get("dreamnode_path")
                        is_local = not dn_path or not Path(dn_path).is_dir()
                        start_msg["cwd"] = str(AURYN_DIR) if is_local else dn_path
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

    prompt = f"""You are a transcript refinement assistant. You receive two transcriptions of the same audio:
- Moonshine (fast, primary): {moonshine_text}
- Whisper (vocabulary-primed): {whisper_text}

Known vocabulary (exact names of projects and concepts the speaker uses, ordered by relevance): {vocab_str}

Recent confirmed sentences:
{context_lines}

Produce the best refined transcript. Rules:
1. Use Moonshine as base, apply vocabulary corrections from Whisper where phonetically plausible
2. Fix punctuation and capitalization
3. When a spoken word matches a vocabulary term, use its EXACT casing from the list above (e.g. "dream notes" → "DreamNodes", "attraxia" → "ATARAXIA", "interbrain" → "InterBrain")
4. When a word happens to match a vocabulary term but is just regular speech, keep it lowercase (e.g. "I love this feature" stays lowercase even if "Love" is in the vocabulary — the speaker is not invoking the concept)
5. When two vocabulary terms sound similar, prefer the one earlier in the list
6. Do NOT add vocabulary terms that were not spoken — only correct terms that sound like they were intended

Respond with ONLY the refined transcript text, nothing else. No JSON, no explanation, no quotes around the text."""

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
        vocab_hits = []
        for term in vocab_list:
            if len(term) < 3:
                continue
            # Use word-boundary-aware search to avoid partial matches
            # For multi-word or CamelCase terms, just check substring
            if term in refined:
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
_whisper_model_size = "base"
_whisper_repo: str = _MLX_WHISPER_MODELS["base"]
def _transcribe_sync(wav_path: str, prompt: str = "") -> dict:
    """Synchronous Whisper transcription. Called from run_in_executor."""
    import mlx_whisper
    return mlx_whisper.transcribe(
        wav_path,
        path_or_hf_repo=_whisper_repo,
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
        Returns list of matched DreamNode info dicts (deduped by uuid). These get pinned."""
        text_lower = text.lower()
        hits = []
        seen_uuids = set()
        for key, info in _vocab_lookup.items():
            if info["uuid"] in seen_uuids:
                continue
            if len(key) <= 3:
                # Short names need word boundaries
                if re.search(r'\b' + re.escape(key) + r'\b', text_lower):
                    hits.append(info)
                    seen_uuids.add(info["uuid"])
            else:
                if key in text_lower:
                    hits.append(info)
                    seen_uuids.add(info["uuid"])
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

    async def _process_new_text(new_text: str) -> str:
        """Process newly transcribed text: check vocab hits, update feedback loop.
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
            # Always notify UI of DreamNode detection (even for core vocab)
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
    # Store Moonshine text per chunk for gatekeeper comparison
    moonshine_chunks: list[dict] = []  # [{index, text, start_sec, end_sec}]
    whisper_last_sec = 0.0  # audio seconds already processed by Whisper

    def _moonshine_transcribe_sync(wav_path: str) -> str:
        """Synchronous Moonshine transcription (non-streaming). Called from executor."""
        if moonshine is None:
            return ""
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
                continue

            total_sec = time.time() - start_time
            if total_sec - moonshine_last_sec < moonshine_interval * 0.5:
                continue  # not enough new audio

            # Extract new audio (small overlap for context)
            overlap = 0.5 if moonshine_last_sec > 0 else 0.0
            extract_from = max(0, moonshine_last_sec - overlap)
            wav_path = await _extract_time_range_file(str(audio_file), extract_from)
            if not wav_path:
                continue

            try:
                new_text = await loop.run_in_executor(None, _moonshine_transcribe_sync, wav_path)
                new_text = _filter_hallucination(new_text)

                if new_text:
                    chunk_idx = moonshine_chunk_index
                    moonshine_chunk_index += 1
                    moonshine_chunks.append({
                        "index": chunk_idx,
                        "text": new_text,
                        "start_sec": moonshine_last_sec,
                        "end_sec": total_sec,
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
        """Stage 2+3: Whisper vocabulary scan + Ollama gatekeeper refinement.
        Runs every chunk_interval seconds. When Moonshine is active, this
        produces corrections rather than primary transcript."""
        nonlocal last_processed_bytes, last_transcribed_sec, whisper_last_sec
        while True:
            await asyncio.sleep(chunk_interval)
            if not audio_file or not audio_file.exists():
                continue
            if len(cumulative_webm) <= last_processed_bytes:
                continue

            total_sec = time.time() - start_time

            # Extract new audio with overlap for Whisper context
            overlap = 1.5 if whisper_last_sec > 0 else 0.0
            extract_from = max(0, whisper_last_sec - overlap)
            wav_path = await _extract_time_range_file(str(audio_file), extract_from)
            if not wav_path:
                last_processed_bytes = len(cumulative_webm)
                continue

            try:
                # Prompt: vocab terms + last transcript chunk for continuity
                prompt = vocab_prompt
                if transcript_parts:
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

                if whisper_text:
                    # Process vocab hits (pinning, BM25 ephemeral update)
                    whisper_text = await _process_new_text(whisper_text)
                    await _send_vocab_state()

                    if moonshine is not None and moonshine_chunks:
                        # Stage 3: Gatekeeper — refine using both outputs
                        # Find Moonshine chunks that overlap this Whisper window
                        moon_texts = [
                            mc["text"] for mc in moonshine_chunks
                            if mc["end_sec"] > whisper_last_sec and mc["start_sec"] < total_sec
                        ]
                        moon_combined = " ".join(moon_texts) if moon_texts else ""
                        chunk_indices = [
                            mc["index"] for mc in moonshine_chunks
                            if mc["end_sec"] > whisper_last_sec and mc["start_sec"] < total_sec
                        ]

                        if moon_combined:
                            # ALWAYS remove processed chunks immediately so they
                            # aren't re-selected on the next Whisper cycle
                            processed_indices = set(chunk_indices)
                            moonshine_chunks[:] = [
                                mc for mc in moonshine_chunks
                                if mc["index"] not in processed_indices
                            ]

                            # Build FULL vocab list for gatekeeper — ALL titles, no cutoff.
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
                            recent_ctx = list(sliding_window[-3:])

                            gatekeeper_result = await _ollama_gatekeeper(
                                moon_combined, whisper_text, all_vocab, recent_ctx
                            )

                            if gatekeeper_result and gatekeeper_result["text"].strip():
                                refined = gatekeeper_result["text"].strip()
                                if refined != moon_combined:
                                    await ws.send_json({
                                        "type": "transcript_correction",
                                        "original_indices": chunk_indices,
                                        "original_text": moon_combined,
                                        "refined_text": refined,
                                        "stage": "gatekeeper",
                                    })
                                    _write_transcript_chunk(f"[refined] {refined}", start_time)
                                    plog(f"[Gatekeeper] Correction: {refined[:80]}...")

                                # Process any vocab hits from gatekeeper
                                core_lower = {t.lower() for t in _CORE_VOCAB}
                                for term in gatekeeper_result.get("vocab_hits", []):
                                    info = _vocab_lookup.get(term.lower())
                                    if info:
                                        if term not in pinned_vocab and info["title"].lower() not in core_lower:
                                            pinned_vocab.append(info["title"])
                                            plog(f"[Gatekeeper] PINNED via LLM: {info['title']}")
                                        await _notify_dreamnode_hit(info)
                                _rebuild_prompt()
                            else:
                                plog(f"[Gatekeeper] No refinement needed or gatekeeper unavailable")
                        else:
                            # No Moonshine chunks to compare — shouldn't happen
                            pass
                    else:
                        # No Moonshine — Whisper is primary (original behavior)
                        chunk_text = " " + whisper_text if transcript_parts else whisper_text
                        await ws.send_json({"type": "transcript_chunk", "text": chunk_text})
                        transcript_parts.append(whisper_text)
                        _write_transcript_chunk(whisper_text, start_time)
                        await _send_vocab_state()

                whisper_last_sec = total_sec
                last_transcribed_sec = total_sec
                last_processed_bytes = len(cumulative_webm)

            except Exception as e:
                plog(f"[Whisper] Transcription error: {e}")
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
                moonshine_chunks.clear()
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

                # Launch pipeline stages as concurrent tasks
                if moonshine is not None:
                    moonshine_task = asyncio.create_task(periodic_moonshine())
                process_task = asyncio.create_task(periodic_whisper_and_gatekeeper())
                pipeline_mode = "three-stage (Moonshine→Whisper→Gatekeeper)" if moonshine else "single-stage (Whisper)"
                plog(f"[Pipeline] Started: {pipeline_mode}")
                await ws.send_json({"type": "session_started", "session_id": session_id, "pipeline": pipeline_mode})

            elif data.get("type") == "end_stream":
                # Cancel all pipeline tasks
                if moonshine is not None and moonshine_task is not None:
                    moonshine_task.cancel()
                    try:
                        await moonshine_task
                    except asyncio.CancelledError:
                        pass
                    moonshine_task = None
                if process_task:
                    process_task.cancel()
                    try:
                        await process_task
                    except asyncio.CancelledError:
                        pass
                    process_task = None

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
                            prompt = vocab_prompt
                            if transcript_parts:
                                recent = transcript_parts[-1]
                                prompt = vocab_prompt + ". " + recent if vocab_prompt else recent

                            result = await loop.run_in_executor(
                                None,
                                lambda: _transcribe_sync(wav_path, prompt),
                            )

                            new_text = " ".join(
                                s["text"].strip() for s in result["segments"]
                            ).strip()
                            if new_text:
                                new_text = await _process_new_text(new_text)
                                chunk_text = " " + new_text if transcript_parts else new_text
                                await ws.send_json({"type": "transcript_chunk", "text": chunk_text})
                                transcript_parts.append(new_text)
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
            cumulative_webm.extend(msg.data)
            if audio_file:
                with open(audio_file, "ab") as f:
                    f.write(msg.data)

        elif msg.type in (aiohttp.WSMsgType.ERROR, aiohttp.WSMsgType.CLOSE):
            break

    if process_task:
        process_task.cancel()
    if moonshine is not None and moonshine_task is not None:
        moonshine_task.cancel()

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
        script = f'while kill -0 {pid} 2>/dev/null; do sleep 0.2; done; cd "{AURYN_DIR}" && uv run aurin.py {cmd_args} &'
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
    result = await run_claude_code(
        prompt=args.prompt,
        model=args.model,
        max_budget=args.budget,
        cwd=args.cwd,
    )

    if result.get("is_error"):
        print(f"Error: {result.get('result', 'Unknown error')}")
    else:
        print(result.get("result", json.dumps(result, indent=2)))

    if result.get("session_id"):
        print(f"\nSession ID: {result['session_id']}")
    if result.get("total_cost_usd"):
        print(f"Cost: ${result['total_cost_usd']:.4f}")


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

    # --- claude ---
    claude_parser = sub.add_parser("claude", help="Run Claude Code as sub-agent")
    claude_parser.add_argument("prompt", help="Prompt for Claude Code")
    claude_parser.add_argument("--model", default="sonnet", help="Model (default: sonnet)")
    claude_parser.add_argument("--budget", type=float, default=0.50, help="Max budget USD")
    claude_parser.add_argument("--cwd", help="Working directory (session continues per directory)")

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
    elif args.command == "claude":
        asyncio.run(_run_claude_cli(args))
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
