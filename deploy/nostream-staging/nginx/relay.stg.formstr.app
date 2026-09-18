server {
    listen 443 ssl;
    server_name relay.stg.formstr.app;

    ssl_certificate /etc/letsencrypt/live/stg.formstr.app/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/stg.formstr.app/privkey.pem;

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
    server_name relay.stg.formstr.app;
    return 301 https://$host$request_uri;
}
