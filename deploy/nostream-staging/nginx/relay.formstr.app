server {
    listen 443 ssl;
    server_name relay.formstr.app;

    ssl_certificate /etc/letsencrypt/live/relay.formstr.app/fullchain.pem; # managed by Certbot
    ssl_certificate_key /etc/letsencrypt/live/relay.formstr.app/privkey.pem; # managed by Certbot
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem; # managed by Certbot
    include /etc/letsencrypt/options-ssl-nginx.conf; # managed by Certbot

    # Optional: redirect regular HTTP requests to HTTPS

    location / {
        limit_conn relay_conn 30;
        limit_req  zone=relay_connrate burst=20 nodelay;
        proxy_pass http://127.0.0.1:8008;

        # Required for WebSockets
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        # Pass original headers
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Timeouts for long-lived WebSocket connections
        proxy_read_timeout 3600;
        proxy_send_timeout 3600;
    }
}

server {
    listen 80;
    server_name relay.formstr.app;
    return 301 https://$host$request_uri;
}
