import subprocess
out = subprocess.check_output(["git", "log", "--oneline", "-n", "8", "index.html"], text=True)
with open("log_check.txt", "w", encoding="utf-8") as f:
    f.write(out)
