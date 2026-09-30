import json
import sys

from app import create_app

# NOTE: Explicitly import configuration so that PyInstaller is able to find and bundle it
import config

application = create_app("config.DevelopmentConfig")

if __name__ == "__main__":
    runtime = config.resolve_config()
    if "--print-config" in sys.argv:
        payload = json.dumps(runtime)
        if sys.stdout is not None:
            print(payload)
        else:
            import os

            try:
                os.write(1, (payload + "\n").encode("utf-8"))
            except OSError:
                pass
    else:
        application.run(host=runtime["host"], port=runtime["port"])
