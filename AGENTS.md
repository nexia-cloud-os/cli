# Developer Kit

Owns the local Nexia CLI and read-only development MCP adapter. Consume the
public protocol/client packages; do not import Core source or invent remote APIs.
Local preview must never be presented as authenticated remote development.
Never read credentials or execute project scripts. Work remains draft until the
user requests verification/finalization. Do not run tests/builds/typechecks in
draft. Do not commit, push, or publish without explicit authorization.
