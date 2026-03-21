import subprocess

with open('found_commit.txt', 'r', encoding='utf-16le') as f:
    text = f.read().strip()
    if text:
        # Get the first word (the hash) and strip BOM
        raw_hash = text.split()[0]
        hash_val = ''.join(c for c in raw_hash if c.isalnum())
        print("Restoring hash:", hash_val)
        subprocess.run(['git', 'checkout', hash_val, '--', 'index.html'])
    else:
        print("No commit found!")
