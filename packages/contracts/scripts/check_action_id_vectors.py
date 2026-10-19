#!/usr/bin/env python3
"""Independent Python check of fixtures/action-id/vectors.json (canonical JSON + actionId parts; the path vectors
are data for the Python canonicaliser E04/E11 write). Reference for Python consumers: stringify_leaves + json.dumps.
Usage: python3 check_action_id_vectors.py [vectors.json]  -> exit 0 and 'ok N' on success."""
import hashlib, json, math, sys

PURPOSE = "dottie.actionId.v1"
KEYS = sorted(["purpose", "method", "args", "targets", "taskId", "threadId", "turnId", "itemId", "requestId", "displayHash", "requestSource"])
REQUEST_SOURCES = ("codex", "tool_host", "coordinator")
HEX64 = set("0123456789abcdef")
MAX_SAFE = 2**53 - 1


class Invalid(ValueError):
    pass


def decode(v):
    if isinstance(v, list):
        return [decode(x) for x in v]
    if isinstance(v, dict):
        if list(v) == ["$number"]:
            return {"NaN": math.nan, "Infinity": math.inf, "-Infinity": -math.inf, "-0": -0.0}[v["$number"]]
        if list(v) == ["$bigint"]:
            return ("bigint", int(v["$bigint"]))
        return {k: decode(x) for k, x in v.items()}
    return v


def leaves(v):
    if v is None:
        return None
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, tuple) and v[0] == "bigint":
        return str(v[1])
    if isinstance(v, int):
        if abs(v) > MAX_SAFE:
            raise Invalid("integer beyond 2^53-1")
        return str(v)
    if isinstance(v, float):
        # JSON text "3" parses as int; anything that arrives as a float is NaN/Inf/-0 or a non-integer, or 2^53+.
        if math.isnan(v) or math.isinf(v) or (v == 0 and math.copysign(1, v) < 0) or not v.is_integer():
            raise Invalid("not an integer")
        if abs(v) > MAX_SAFE:
            raise Invalid("integer beyond 2^53-1")
        return str(int(v))
    if isinstance(v, str):
        if any(0xD800 <= ord(c) <= 0xDFFF for c in v):
            raise Invalid("lone surrogate")
        return v
    if isinstance(v, list):
        return [leaves(x) for x in v]
    if isinstance(v, dict):
        return {k: leaves(x) for k, x in v.items()}
    raise Invalid(type(v).__name__)


def canonical(v):
    return json.dumps(leaves(v), sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def action_id(b):
    for k in ["method", "args", "targets", "taskId", "threadId", "turnId", "itemId", "requestId", "displayHash", "requestSource"]:
        if k not in b:
            raise Invalid("missing " + k)
    if not isinstance(b["taskId"], str) or b["taskId"] == "" or not isinstance(b["method"], str) or b["method"] == "":
        raise Invalid("empty id")
    dh = b["displayHash"]
    if dh is not None and not (isinstance(dh, str) and len(dh) == 64 and set(dh) <= HEX64):
        raise Invalid("displayHash must be lowercase hex sha256 or null")
    if "purpose" in b and b["purpose"] != PURPOSE:
        raise Invalid("wrong purpose")
    # ruling 1r: requestSource next to displayHash; coordinator exactly for the pre-dispatch method.
    if b["requestSource"] not in REQUEST_SOURCES:
        raise Invalid("unknown requestSource")
    if (b["method"] == "dottie.pre_dispatch_confirmation") != (b["requestSource"] == "coordinator"):
        raise Invalid("requestSource coordinator exactly for the pre-dispatch method")
    # ruling 1q: top-level displayHash authoritative; pre-dispatch args carry the same value; generic args never do.
    args_has = isinstance(b["args"], dict) and "displayHash" in b["args"]
    if b["method"] == "dottie.pre_dispatch_confirmation":
        if not args_has or b["args"]["displayHash"] != dh:
            raise Invalid("pre-dispatch args.displayHash != displayHash")
    elif args_has:
        raise Invalid("generic call with displayHash in args")
    o = dict(b, purpose=PURPOSE)
    if sorted(o) != KEYS:
        raise Invalid("wrong key set")
    text = canonical(o)
    return text, hashlib.sha256(text.encode("utf-8")).hexdigest()


def main(path):
    # object_pairs_hook rejects duplicate keys (ADR-0009 CR2) in the fixture itself too.
    def no_dups(pairs):
        d = {}
        for k, v in pairs:
            if k in d:
                raise Invalid("duplicate key " + k)
            d[k] = v
        return d

    with open(path, encoding="utf-8") as f:
        d = json.load(f, object_pairs_hook=no_dups)
    assert d["purpose"] == PURPOSE
    n = 0
    for v in d["canonicalJson"]:
        got = canonical(decode(v["input"]))
        assert got == v["canonical"], (v["name"], got, v["canonical"])
        n += 1
    for v in d["canonicalJsonInvalid"]:
        try:
            canonical(decode(v["input"]))
        except (Invalid, ValueError):
            n += 1
            continue
        raise AssertionError("accepted invalid vector: " + v["name"])
    hashes = {}
    for v in d["displays"]:
        text = canonical(v["display"])
        assert text == v["canonical"], (v["name"], text)
        h = hashlib.sha256(text.encode("utf-8")).hexdigest()
        assert h == v["displayHash"], (v["name"], h)
        hashes[v["name"]] = h
        n += 1
    for v in d["actionId"]:
        text, aid = action_id(decode(v["input"]))
        assert text == v["canonical"], (v["name"], text)
        assert aid == v["actionId"], (v["name"], aid)
        assert aid == aid.lower() and len(aid) == 64
        ref = v.get("display")
        if ref is not None:
            assert v["input"]["displayHash"] == hashes[ref], (v["name"], "displayHash is not the named display's hash")
            if v["input"]["method"] == "dottie.pre_dispatch_confirmation" and v.get("argsDisplay", ref) == ref:
                assert v["input"]["args"]["displayHash"] == hashes[ref], (v["name"], "args.displayHash")
        n += 1
    for v in d["actionIdInvalid"]:
        try:
            action_id(decode(v["input"]))
        except (Invalid, ValueError):
            n += 1
            continue
        raise AssertionError("accepted invalid vector: " + v["name"])
    print("ok", n)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else __file__.rsplit("/", 2)[0] + "/fixtures/action-id/vectors.json")
