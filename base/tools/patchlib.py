"""Exact, line-ending-preserving search/replace for scripted file edits."""


def patch(path, pairs, count=1):
    """Apply (old, new) pairs to `path`. Each `old` must occur exactly `count` times.

    `\\n` in the pairs is converted to the file's own line ending (CRLF or LF).
    The file is written only if every pair matches.
    """
    with open(path, encoding='utf-8', newline='') as f:
        s = f.read()
    nl = '\r\n' if '\r\n' in s else '\n'
    for old, new in pairs:
        old, new = old.replace('\n', nl), new.replace('\n', nl)
        found = s.count(old)
        assert found == count, f'{path}: expected {count} match(es), found {found}: {old[:80]!r}'
        s = s.replace(old, new)
    with open(path, 'w', encoding='utf-8', newline='') as f:
        f.write(s)
