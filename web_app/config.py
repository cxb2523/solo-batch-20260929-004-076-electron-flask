import json
import os
import sys


# Canonical defaults. Every resolved value in dev or packaged mode is derived
# through `resolve_config` below. Nothing in the application ever writes the
# configuration back.
DEFAULTS = {
    "host": "0.0.0.0",
    "port": 4040,
    "secret_key": "REPLACE ME",
    "debug": False,
}

# Only these environment variables are consulted, and only in dev mode.
ENV_KEYS = {
    "WEB_APP_HOST": ("host", str),
    "WEB_APP_PORT": ("port", int),
    "SECRET_KEY": ("secret_key", str),
    "FLASK_DEBUG": ("debug", lambda value: str(value).lower() in ("1", "true", "yes")),
}

CONFIG_FILE_NAME = "web_app_config.json"


def is_packaged():
    """True when running from a PyInstaller bundle."""
    return bool(getattr(sys, "frozen", False))


def packaged_config_path():
    """
    Read-only location of the resolved configuration snapshot.

    The snapshot is generated at packaging time (see --print-config /
    package_python.js) and shipped next to the executable. It is only ever
    read, never written at runtime.
    """
    if is_packaged():
        base_dir = os.path.dirname(sys.executable)
    else:
        base_dir = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(base_dir, CONFIG_FILE_NAME)


def _read_packaged_config(config_path=None):
    resolved_path = config_path or packaged_config_path()
    if not os.path.exists(resolved_path):
        return {}
    with open(resolved_path, "r", encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        raise ValueError("packaged configuration must be a JSON object")
    return data


def resolve_config(packaged=None, env=None, config_path=None):
    """
    The single parsing function shared by the Flask app, run_app.py and the
    Node supervisor (via `python config.py --print-config`).

    * dev mode       - defaults, then environment overrides
    * packaged mode  - defaults, then the read-only shipped snapshot

    The function is pure: it never mutates the environment and never writes
    anything back to disk.
    """
    if packaged is None:
        packaged = is_packaged()
    if env is None:
        env = os.environ

    resolved = dict(DEFAULTS)

    if packaged:
        resolved.update(_read_packaged_config(config_path))
    else:
        for env_name, (key, caster) in ENV_KEYS.items():
            if env_name in env and env[env_name] != "":
                resolved[key] = caster(env[env_name])

    return resolved


_RESOLVED = resolve_config()


class BaseConfig:
    SECRET_KEY = _RESOLVED["secret_key"]
    HOST = _RESOLVED["host"]
    PORT = _RESOLVED["port"]


class DevelopmentConfig(BaseConfig):
    DEBUG = True


class TestingConfig(BaseConfig):
    DEBUG = True


class ProductionConfig(BaseConfig):
    pass


if __name__ == "__main__":
    # Emit the resolved configuration as JSON for the Node side. In packaged
    # mode this reads the shipped snapshot, in dev mode it reads the process
    # environment - both through the same parser.
    print(json.dumps(resolve_config(), sort_keys=True))
