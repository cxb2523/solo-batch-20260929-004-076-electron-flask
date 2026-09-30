import json
import os
import sys

DEFAULTS = {
    "host": "0.0.0.0",
    "port": 4040,
    "secret_key": "REPLACE ME",
    "startup_timeout_ms": 30000,
    "poll_interval_ms": 250,
}

ENV_KEYS = {
    "host": "FLASK_HOST",
    "port": "FLASK_PORT",
    "secret_key": "SECRET_KEY",
    "startup_timeout_ms": "FLASK_STARTUP_TIMEOUT_MS",
    "poll_interval_ms": "FLASK_POLL_INTERVAL_MS",
}


def is_packaged():
    return bool(getattr(sys, "frozen", False))


def packaged_config_path():
    base = getattr(sys, "_MEIPASS", os.path.abspath(os.path.dirname(__file__)))
    return os.path.join(base, "config.json")


def _coerce_int(value):
    return int(str(value).strip())


def resolve_config(env=None, packaged_path=None):
    """Single configuration parser: dev reads environment, package reads a read-only file."""
    env = os.environ if env is None else env
    values = dict(DEFAULTS)

    if is_packaged():
        path = packaged_config_path() if packaged_path is None else packaged_path
        with open(path, "r", encoding="utf-8") as handle:
            file_values = json.load(handle)
        for key in DEFAULTS:
            if key in file_values:
                values[key] = file_values[key]
    else:
        for key, env_name in ENV_KEYS.items():
            if env_name in env:
                values[key] = env[env_name]

    values["port"] = _coerce_int(values["port"])
    values["startup_timeout_ms"] = _coerce_int(values["startup_timeout_ms"])
    values["poll_interval_ms"] = _coerce_int(values["poll_interval_ms"])
    return values


RUNTIME = resolve_config()


class BaseConfig:
    SECRET_KEY = RUNTIME["secret_key"]


class DevelopmentConfig(BaseConfig):
    DEBUG = True


class TestingConfig(BaseConfig):
    DEBUG = True


class ProductionConfig(BaseConfig):
    pass
