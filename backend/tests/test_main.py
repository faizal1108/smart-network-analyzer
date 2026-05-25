from fastapi.testclient import TestClient
import sys
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parent.parent))

from main import app

client = TestClient(app)


def test_ping():
    response = client.get("/ping")

    assert response.status_code == 200
    assert response.json()["message"] == "pong"


def test_network_interfaces():
    response = client.get("/network-interfaces")

    assert response.status_code == 200


def test_network_stats():
    response = client.get("/network-stats")

    assert response.status_code == 200


def test_ip():
    response = client.get("/ip")

    assert response.status_code == 200


def test_security_score():
    response = client.get("/security-score")

    assert response.status_code == 200