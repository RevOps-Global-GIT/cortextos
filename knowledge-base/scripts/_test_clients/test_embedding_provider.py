"""Behavioral tests for mmrag embedding provider selection.

Run from knowledge-base/scripts:

    python -m _test_clients.test_embedding_provider
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PARENT = os.path.dirname(HERE)
if PARENT not in sys.path:
    sys.path.insert(0, PARENT)

import mmrag


FAILURES = []


def _check(label, cond, detail=""):
    if cond:
        print(f"  PASS  {label}")
    else:
        print(f"  FAIL  {label}: {detail}")
        FAILURES.append(label)


def _with_env(**updates):
    class _Env:
        def __enter__(self):
            self.old = {k: os.environ.get(k) for k in updates}
            for k, v in updates.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v

        def __exit__(self, *args):
            for k, v in self.old.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v

    return _Env()


def test_openai_provider_flag_overrides_gemini_config():
    print("\n[test 1/4] openai provider flag overrides existing Gemini config")
    config = {
        "embedding_model": "gemini-embedding-2-preview",
        "embedding_dimensions": 3072,
    }
    with _with_env(MMRAG_EMBEDDING_PROVIDER="openai", MMRAG_EMBEDDING_MODEL=None):
        _check("provider is openai", mmrag.get_embedding_provider(config) == "openai")
        _check(
            "model falls back to text-embedding-3-large",
            mmrag.get_embedding_model(config, "openai") == "text-embedding-3-large",
            detail=mmrag.get_embedding_model(config, "openai"),
        )


def test_openai_model_implies_provider():
    print("\n[test 2/4] OpenAI model implies OpenAI provider")
    config = {"embedding_model": "text-embedding-3-large"}
    with _with_env(MMRAG_EMBEDDING_PROVIDER=None, MMRAG_EMBEDDING_MODEL=None):
        _check("provider inferred as openai", mmrag.get_embedding_provider(config) == "openai")


def test_media_parts_become_text_placeholders():
    print("\n[test 3/4] media parts become text placeholders for OpenAI embeddings")

    class _Part:
        mime_type = "image/png"

    text = mmrag._content_to_text(["description", _Part()])
    _check("keeps text part", "description" in text)
    _check("adds media placeholder", "image/png" in text)


def test_split_ingest_clients_backcompat():
    print("\n[test 4/4] split_ingest_clients keeps single-client backcompat")
    one = object()
    a, b = mmrag.split_ingest_clients(one)
    _check("single client returns same object twice", a is one and b is one)
    emb, gen = object(), object()
    a, b = mmrag.split_ingest_clients((emb, gen))
    _check("tuple client returns embedding/generation pair", a is emb and b is gen)


if __name__ == "__main__":
    test_openai_provider_flag_overrides_gemini_config()
    test_openai_model_implies_provider()
    test_media_parts_become_text_placeholders()
    test_split_ingest_clients_backcompat()
    print()
    if FAILURES:
        print(f"FAILED: {len(FAILURES)} assertion(s)")
        for f in FAILURES:
            print(f"  - {f}")
        sys.exit(1)
    print("ALL PASS (4 scenarios)")
    sys.exit(0)
