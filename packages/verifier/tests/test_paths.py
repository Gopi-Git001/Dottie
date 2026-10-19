import pytest

from dottie_verifier.paths import file_url_to_path, normalize, same_path, strip_extended_prefix


@pytest.mark.parametrize("a,b", [
    (r"C:\Users\<USER>\Downloads", r"c:\users\<user>\downloads"),
    (r"C:\Users\<USER>\Downloads\\", r"C:\Users\<USER>\Downloads"),
    ("C:/Users/<USER>/Downloads", r"C:\Users\<USER>\Downloads"),
    (r"\\?\C:\Users\<USER>\Downloads", r"C:\Users\<USER>\Downloads"),
    (r"C:\Users\<USER>\.\x\..\Downloads", r"C:\Users\<USER>\Downloads"),
    (r"\\?\UNC\server\share\Downloads", r"\\server\share\Downloads"),
])
def test_equivalent_paths(a, b):
    assert same_path(a, b)


@pytest.mark.parametrize("value", ["", "Downloads", r"Users\x", "shell:Downloads",
                                   "::{20D04FE0-3AEA-1069-A2D8-08002B30309D}"])
def test_non_filesystem_values_never_match(value):
    assert normalize(value) == ""
    assert not same_path(value, r"C:\Users\<user>\Downloads")


def test_drive_root_keeps_backslash():
    assert normalize("C:") == "c:\\" and normalize("C:\\") == "c:\\"


def test_prefix_strip():
    assert strip_extended_prefix(r"\\?\D:\x") == r"D:\x"


@pytest.mark.parametrize("url,expected", [
    ("file:///C:/Users/<user>%20t/Downloads", r"C:\Users\<user> t\Downloads"),
    ("file://server/share/Down%C3%A9", r"\\server\share\Downé"),
    ("file://localhost/C:/x", r"C:\x"),
    ("::{20D04FE0-3AEA-1069-A2D8-08002B30309D}", ""),
    ("", ""),
])
def test_file_urls(url, expected):
    assert file_url_to_path(url) == expected


def test_resolver_follows_aliases_only_when_text_differs():
    calls = []

    def resolver(p):
        calls.append(p)
        return {r"C:\Users\<USER>~1\Downloads": r"\\?\C:\Users\<user>\Downloads"}.get(p, p)

    assert same_path(r"C:\Users\<USER>~1\Downloads", r"C:\Users\<user>\Downloads", resolver)
    assert not same_path(r"C:\Users\<user>\Documents", r"C:\Users\<user>\Downloads", resolver)
    calls.clear()
    assert same_path(r"C:\A", r"c:\a", resolver) and calls == []
    assert not same_path(r"C:\A", r"C:\B", lambda p: None)
