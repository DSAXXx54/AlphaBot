import base64
import hashlib
import json

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.core.config import settings
from app.services.app_cipher import encrypt_client_payload


def test_encrypt_client_payload_keeps_data_outside_envelope():
    payload = {"version": "test", "private": {"rebound": {"weights": {"gap2": 8}}}, "notice": "赞助"}

    envelope = encrypt_client_payload(payload, aad=b"alphabot:test:v1")

    assert set(envelope) == {"payload"}
    encoded = envelope["payload"].removeprefix("v1.")
    raw = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))
    key = hashlib.sha256(settings.APP_CIPHER_KEY_MATERIAL.encode("utf-8")).digest()
    plaintext = AESGCM(key).decrypt(raw[:12], raw[12:], b"alphabot:test:v1")
    assert json.loads(plaintext) == payload
