import sys
import os
import subprocess
from pathlib import Path
from dotenv import load_dotenv
from aider.coders import Coder
from aider.models import Model
from aider.io import InputOutput

load_dotenv()

def run_aider_session(input_file):
    model = Model("claude-3-5-sonnet-20240620")
    io = InputOutput(yes=True)

    with open(input_file, 'r') as f:
        user_input = f.read()

    fnames = ["magic_prompt.txt", "project_name.txt", "project_prompt.txt"]
    coder = Coder.create(main_model=model, fnames=fnames, io=io)

    # Add magic prompt and user input to the chat
    coder.run(user_input)

    # The Aider session will now process the input and generate a project name and initial prompt
    # It will then run the dreamnode_creator.py script and start a new Aider session in the new project

def main():
    if len(sys.argv) != 2:
        print("Usage: python auryn.py <input_file_path>")
        sys.exit(1)

    input_file = sys.argv[1]
    magic_prompt_file = "magic_prompt.txt"

    if not os.path.exists(input_file):
        print(f"Error: Input file '{input_file}' not found.")
        sys.exit(1)

    run_aider_session(input_file)

    subprocess.run(["python", "dreamnode_creator.py", "project_name.txt", "project_prompt.txt"], check=True)

    # delete content of text files
    open("project_name.txt", 'w').close()
    open("project_prompt.txt", 'w').close()

if __name__ == "__main__":
    main()
