import pytest

from tests.fakes import FakeDesktop


class FakeClock:
    def __init__(self):
        self.t = 0.0
        self.sleeps: list[float] = []

    def __call__(self) -> float:
        return self.t

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.t += seconds


@pytest.fixture
def desktop():
    return FakeDesktop()


@pytest.fixture
def clock():
    return FakeClock()
