"""dottie-tools (packages/tools): Windows tool adapters for Dottie. Owner E04.

Today this holds the contract layer only, with Windows mocked:
* ``dottie_tools.targets``: the shared window-identity / candidate-id registry (CONTRACTS §3.3, §5; reviewer E11).
* ``dottie_tools.reference``: a clean-room contract reference for ``explorer.open_known_folder`` plus the
  approval-binding / K8-token / catalog models used by the tests. Not production code, not derived from Bot.
"""
