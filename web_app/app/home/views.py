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


def healthz():
    """
    Liveness probe polled by the supervisor handshake. The route itself is
    registered in create_app so it exists independently of any template work.
    """
    return jsonify(status="ok"), 200
