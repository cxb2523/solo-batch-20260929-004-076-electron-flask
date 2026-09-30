from flask import jsonify, render_template
from . import home


@home.route("/")
def homepage():
    """
    Render the homepage template on the / route
    """
    return render_template("page/home/index.html", title="Welcome")


@home.route("/dashboard")
def dashboard():
    """
    Render the dashboard template on the /dashboard route
    """
    return render_template("page/home/dashboard.html", title="Dashboard")


@home.route("/healthz")
def healthz():
    """Liveness probe consumed by the supervisor handshake; stdout is never parsed."""
    return jsonify(status="ok"), 200
