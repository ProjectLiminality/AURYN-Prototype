import sys
import os
import subprocess
import shutil
from pathlib import Path

def create_repository(project_name):
    template_path = "../DreamNode"
    new_repo_path = f"../{project_name}"

    print(f"Cloning template repository to create {project_name}...")
    subprocess.run(["git", "clone", str(template_path), str(new_repo_path)], check=True)
    
    os.chdir(new_repo_path)
    print("Removing origin remote...")
    subprocess.run(["git", "remote", "remove", "origin"], check=True)
    
    # Copy .env file from Auryn's directory to the new repository
    auryn_dir = Path(__file__).parent.absolute()
    env_file = auryn_dir / '.env'
    if env_file.exists():
        shutil.copy(env_file, '.')
        print(f"Copied .env file to {project_name}")
    else:
        print("Warning: .env file not found in Auryn's directory")

    # Add .env to .gitignore
    with open('.gitignore', 'a') as gitignore:
        gitignore.write('\n.env\n')
    print("Added .env to .gitignore")

    print(f"Repository '{project_name}' created successfully.")

def spawn_aider_session(project_path, project_prompt):
    print(f"Spawning Aider session in {project_path}...")

    # Remove newlines and escape double quotes in project_prompt
    escaped_prompt = project_prompt.replace('\n', ' ').replace('"', '\\"')

    # Construct the AppleScript command with project_prompt enclosed in double quotes
    applescript = f'''
    tell application "Terminal"
        do script "cd '{project_path}' && codad && aider --yes --message \\"{escaped_prompt}\\""
        activate
    end tell
    '''

    # Execute the AppleScript command
    subprocess.run(["osascript", "-e", applescript], check=True)
    print("Aider session spawned successfully.")

if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: python dreamnode_creator.py project_name.txt project_prompt.txt")
        sys.exit(1)
    
    # Read content of text files
    with open(sys.argv[1], 'r') as f:
        project_name = f.read().strip()

    with open(sys.argv[2], 'r') as f:
        project_prompt = f.read().strip()

    create_repository(project_name)
    
    # Get the full path of the new repository
    new_repo_path = os.path.abspath(f"../{project_name}")
    
    # Spawn the Aider session in the new repository
    spawn_aider_session(new_repo_path, project_prompt)
