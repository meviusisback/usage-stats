"""Agent-side registration shim for the unified OpenCode Usage plugin."""


def register(ctx) -> None:
    """The plugin contributes no agent tools; its API is mounted by Hermes Dashboard."""
    return None
