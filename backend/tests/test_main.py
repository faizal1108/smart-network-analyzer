from fastapi.testclient import TestClient
from main import app

client = TestClient(app)


def test_ping():
    response = client.get("/ping")

    assert response.status_code == 200
    data = response.json()

    assert data["message"] == "pong"
    assert "timestamp" in data


def test_network_interfaces():
    response = client.get("/network-interfaces")

    assert response.status_code == 200
    data = response.json()

    assert "interfaces" in data
    assert "active_count" in data


def test_network_stats():
    response = client.get("/network-stats")

    assert response.status_code == 200

    data=response.json()

    assert "bytes_sent" in data
    assert "bytes_received" in data


def test_ip_endpoint():

    response=client.get("/ip")

    assert response.status_code==200

    data=response.json()

    assert "hostname" in data


def test_network_stability():

    response=client.get("/network-stability")

    assert response.status_code==200

    data=response.json()

    assert "ping" in data
    assert "quality" in data


def test_security_score():

    response=client.get("/security-score")

    assert response.status_code==200

    data=response.json()

    assert "score" in data
    assert "risk" in data


def test_website_ping():

    payload={
        "host":"google.com"
    }

    response=client.post(
        "/website-ping",
        json=payload
    )

    assert response.status_code==200

    data=response.json()

    assert "reachable" in data