import subprocess
out = subprocess.check_output(["git", "log", "--oneline", "index.html"], text=True)
for i, c in enumerate(out.strip().split('\n')):
    print(f"[{i}] {c}")
