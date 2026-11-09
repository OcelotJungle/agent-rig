"""The single rule for which HTTP failures of a free model are permanent, shared by volunteer-run.py and
volunteer-models.py.

A permanent status means the request or the credentials are wrong or the model is gone: retrying the same model cannot
help. Everything else (5xx, 408, 429, and code 0 = no HTTP answer at all: timeout, connection error) is transient: the
model may work a minute later.
"""

# 400/401/403/404/413: the request, credentials or session size are wrong; 410: the model is gone for good.
PERMANENT_STATUSES = (400, 401, 403, 404, 410, 413)


def is_permanent_status(code):
    """True when `code` is an HTTP status that no retry fixes. Code 0 (no HTTP answer) is transient."""
    return code in PERMANENT_STATUSES
