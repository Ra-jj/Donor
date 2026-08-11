# Donor Deployment Guide

This guide walks you through deploying the Donor application as a full-stack, single-service application on **Render**, with the database on **MongoDB Atlas**.

## Step 1: MongoDB Atlas (Database)
1. Go to [MongoDB Atlas](https://www.mongodb.com/cloud/atlas) and create an account or sign in.
2. Create a new **Free Cluster** (M0).
3. Under **Security > Database Access**, create a new database user. Save the **username** and **password**.
4. Under **Security > Network Access**, click "Add IP Address" and select **"Allow Access from Anywhere"** (`0.0.0.0/0`).
5. Click **Connect** on your cluster, select **Drivers**, and copy your connection string. 
   - Replace `<password>` with the password you created in step 3.
   - Example: `mongodb+srv://admin:mysecretpassword@cluster0.abcde.mongodb.net/donor_db?retryWrites=true&w=majority`
6. Save this connection string as your `MONGO_URI`.

## Step 2: Render (Full-Stack Application)
1. Push your entire project to a GitHub repository.
2. Go to [Render](https://render.com/) and create a new **Web Service**.
3. Connect your GitHub repository.
4. **Configuration:**
   - **Name:** `donor-app` (or similar)
   - **Environment:** `Node`
   - **Root Directory:** *(Leave completely blank! We are deploying the root folder)*
   - **Build Command:** `npm run build`
   - **Start Command:** `npm start`
5. **Environment Variables** (Add these under Advanced):
   - `NODE_ENV`: `production`
   - `PORT`: `8000`
   - `MONGO_URI`: *(Your connection string from Step 1)*
   - `JWT_SECRET`: *(Generate a random long string, e.g., `super_secret_jwt_key_2026!@#`)*
6. Click **Create Web Service**. 

## What Happens During Deployment?
1. Render runs `npm run build` at the root level.
2. This triggers the script: `npm install --prefix client && npm run build --prefix client`, which builds your Vite React frontend into static files (`client/dist`).
3. Render then runs `npm start`, which triggers `node server/index.js`.
4. Your Express backend starts up, connects to MongoDB, and serves those built static files (`client/dist`) to anyone who visits the root URL.

## You are live! 🚀
Once Render finishes building and starting (this might take 3-5 minutes the first time), you can go to your live Render URL (e.g., `https://donor-app-abcd.onrender.com`) and test the full application end-to-end!
