#!/bin/sh

# Create cache directory if it doesn't exist
mkdir -p /tmp/cache

# Start the Next.js server
exec node server.js