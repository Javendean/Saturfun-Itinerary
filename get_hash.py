import subprocess
with open("gitlog.txt", "r", encoding="utf-16-le") as f:
    for line in f:
        if "scattered" in line.strip().lower():
            hash_val = line.split()[0]
            print("FOUND HASH:", hash_val)
            subprocess.run(["git", "checkout", hash_val, "--", "index.html"])
            print("Checked out index.html from", hash_val)
            break
