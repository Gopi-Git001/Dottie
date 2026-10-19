"""Scratch sketch of the shared window-target registry (packages/tools, owner E04, reviewer E11)."""
from dottie_tools.targets.window_registry import (  # noqa: F401
    DEFAULT_TTL_S, TARGET_ID_RE, CanonicalError, parse_canonical, HostContext, IdentityFormatError, Liveness, Resolution,
    WindowFieldReader, WindowIdentity, WindowIdentityService, WindowRegistry, canonical_json, check_live,
    Actionability, NotActionable, actionability, to_physical, window_dpi,
    identify, identity_digest, is_well_formed_target_id, live_identities, liveness,
)
