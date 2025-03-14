#!/bin/bash

# Step 1: SCP everything that isn't in .gitignore and .git to the remote server
rsync -avz --exclude-from='.gitignore' --exclude='.git' --include='.env' --delete ./ root@ai-betworks.com:/root/ai-betworks-backend/
(cd ../ai-betworks-eliza-starter && rsync -avz --exclude-from='.gitignore' --exclude='.git' --include='.env'  --delete ./ root@ai-betworks.com:/root/ai-betworks-eliza)
scp .env root@ai-betworks.com:/root/ai-betworks-backend/.env
(cd ../ai-betworks-eliza-starter && scp .env root@ai-betworks.com:/root/ai-betworks-eliza/.env)

#rsync -avz --exclude-from='.gitignore' --exclude='.git' --include='.envrc.prod' ./ root@88.99.99.179:/root/ai-betworks-backend/
#(cd ../ai-betworks-eliza && rsync -avz --exclude-from='.gitignore' --exclude='.git' --include='.env.prod' ./ root@88.99.99.179:/root/ai-betworks-eliza/)

## Step 2: SSH into the remote server, navigate to the directory, rename .envrc.prod to .envrc and run the docker commands
ssh root@ai-betworks.com << 'ENDSSH'
  cd /root/ai-betworks-backend/
  docker image build -t ai-betworks-backend .
  (cd ../ai-betworks-eliza && docker image build -t ai-betworks-eliza .)
  docker image build -t ai-betworks-eliza .  
ENDSSH

# docker compose down
# docker compose up -d