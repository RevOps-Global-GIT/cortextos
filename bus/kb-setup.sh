#!/usr/bin/env bash
# kb-setup.sh — Initialize the cortextOS knowledge base for an org
# Creates the Python venv and ChromaDB directory structure.
#
# Usage: bash bus/kb-setup.sh [--org ORG] [--instance ID]
# Env:   CTX_ORG, CTX_INSTANCE_ID, CTX_FRAMEWORK_ROOT, OPENAI_API_KEY, GEMINI_API_KEY

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FRAMEWORK_ROOT="${CTX_FRAMEWORK_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"

# Source env if available
ENV_FILE="${FRAMEWORK_ROOT}/.env"
[[ -f "$ENV_FILE" ]] && set -o allexport && source "$ENV_FILE" && set +o allexport

# Resolve args / env
ORG="${CTX_ORG:-}"
INSTANCE_ID="${CTX_INSTANCE_ID:-default}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --org) ORG="$2"; shift 2 ;;
    --instance) INSTANCE_ID="$2"; shift 2 ;;
    *) echo "Unknown flag: $1"; exit 1 ;;
  esac
done

if [[ -z "$ORG" ]]; then
  echo "ERROR: --org or CTX_ORG required"
  exit 1
fi

# Paths
KB_ROOT="$HOME/.cortextos/$INSTANCE_ID/orgs/$ORG/knowledge-base"
CHROMADB_DIR="$KB_ROOT/chromadb"
VENV_DIR="$FRAMEWORK_ROOT/knowledge-base/venv"
MMRAG_PY="$FRAMEWORK_ROOT/knowledge-base/scripts/mmrag.py"
REQS="$FRAMEWORK_ROOT/knowledge-base/scripts/requirements.txt"

echo "Setting up cortextOS knowledge base"
echo "  Org: $ORG"
echo "  Instance: $INSTANCE_ID"
echo "  ChromaDB: $CHROMADB_DIR"
echo "  Venv: $VENV_DIR"
echo ""

# Create ChromaDB directory
mkdir -p "$CHROMADB_DIR"
echo "  [OK] ChromaDB directory created"

# Create Python venv if not present
if [[ ! -d "$VENV_DIR" ]]; then
  echo "  Creating Python venv..."
  python3 -m venv "$VENV_DIR"
  echo "  [OK] Venv created"
else
  echo "  [OK] Venv already exists"
fi

# Resolve platform-specific venv paths (Windows uses Scripts/, Unix uses bin/)
if [[ -d "$VENV_DIR/Scripts" ]]; then
  VENV_BIN="$VENV_DIR/Scripts"
else
  VENV_BIN="$VENV_DIR/bin"
fi

# Install/upgrade dependencies
echo "  Installing Python dependencies..."
"$VENV_BIN/pip" install --quiet --upgrade pip 2>/dev/null || true
"$VENV_BIN/pip" install --quiet -r "$REQS"
echo "  [OK] Dependencies installed"

# Validate mmrag.py is accessible
if [[ ! -f "$MMRAG_PY" ]]; then
  echo "  ERROR: mmrag.py not found at $MMRAG_PY"
  exit 1
fi
echo "  [OK] mmrag.py present"

# Create mmrag config.json if it doesn't exist (mmrag.py requires it to exist)
CONFIG_FILE="$KB_ROOT/config.json"
if [[ ! -f "$CONFIG_FILE" ]]; then
  cat > "$CONFIG_FILE" << 'EOF'
{
  "embedding_provider": "openai",
  "embedding_model": "text-embedding-3-large",
  "embedding_dimensions": 3072,
  "gemini_model": "gemini-2.5-flash",
  "text_chunk_size": 1000,
  "text_chunk_overlap": 200,
  "similarity_threshold": 0.5,
  "default_collection": "shared"
}
EOF
  echo "  [OK] mmrag config.json created"
else
  echo "  [OK] mmrag config.json already exists"

  # Migrate stale embedding config. Gemini text embeddings were replaced by
  # OpenAI text-embedding-3-large, while Gemini remains available for media
  # descriptions via gemini_model.
  if grep -qE '"embedding_model"\s*:\s*"(models/text-embedding-004|text-embedding-004|gemini-embedding-[^"]+)"' "$CONFIG_FILE" 2>/dev/null || \
     ! grep -qE '"embedding_provider"\s*:' "$CONFIG_FILE" 2>/dev/null; then
    "$VENV_BIN/python3" - "$CONFIG_FILE" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
data = json.loads(path.read_text())
data["embedding_provider"] = "openai"
data["embedding_model"] = "text-embedding-3-large"
data["embedding_dimensions"] = 3072
path.write_text(json.dumps(data, indent=2) + "\n")
PY
    echo "  [MIGRATED] embedding provider updated to OpenAI text-embedding-3-large"
  fi
fi

# Test import
MMRAG_DIR="$KB_ROOT" \
MMRAG_CHROMADB_DIR="$CHROMADB_DIR" \
MMRAG_CONFIG="$CONFIG_FILE" \
"$VENV_BIN/python3" -c "import chromadb; import google.genai; print('  [OK] Core imports work')" 2>/dev/null || \
"$VENV_BIN/python" -c "import chromadb; import google.genai; print('  [OK] Core imports work')"

echo ""
echo "Knowledge base ready for org: $ORG"
echo ""
echo "  Next steps:"
echo "    1. Add OPENAI_API_KEY to orgs/$ORG/secrets.env"
echo "       Add GEMINI_API_KEY only if ingesting images, audio, video, PDFs, or Office docs"
echo "    2. Run: bash bus/kb-ingest.sh /path/to/docs --org $ORG"
echo "    3. Query: bash bus/kb-query.sh 'your question' --org $ORG"
