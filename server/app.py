import os
from flask import Flask
from flask_cors import CORS

from routes.compile import compile_bp
from routes.health import health_bp
from middleware.rate_limit import init_limiter

app = Flask(__name__)

# CORS configuration — only accept requests from GitHub Pages
allowed_origins = os.environ.get(
    'ALLOWED_ORIGINS',
    'https://bradbrok.github.io'
).split(',')

CORS(app, origins=allowed_origins, expose_headers=[
    'X-Compile-Time', 'X-Binary-Size', 'X-Target-Address'
])

# Rate limiting
init_limiter(app)

# Register blueprints
app.register_blueprint(compile_bp)
app.register_blueprint(health_bp)

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port)
