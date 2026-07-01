<div align="center">

# 🎓 FaceAttend AI

**Next-Generation Biometric Attendance & Campus Management System**

[![Status: Production Ready](https://img.shields.io/badge/Status-Production%20Ready-success?style=for-the-badge&logo=vercel)](https://github.com/2024f-mulug-1293-tech)
[![Tech: Vanilla JS](https://img.shields.io/badge/Tech-Vanilla%20JS-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black)]()
[![Backend: Supabase](https://img.shields.io/badge/Backend-Supabase-3ECF8E?style=for-the-badge&logo=supabase&logoColor=white)](https://supabase.com)
[![License: Proprietary](https://img.shields.io/badge/License-Proprietary-red?style=for-the-badge)]()

FaceAttend AI is a blazing-fast, serverless Single Page Application (SPA) built to revolutionize how educational institutions handle attendance. Using client-side neural networks, it instantly identifies students and seamlessly syncs data to the cloud in milliseconds. 

**Developed exclusively for Minhaj University Lahore.**
<br><br>
</div>

---

## ✨ System Architecture & Modern Features

FaceAttend is engineered to be lightweight, secure, and infinitely scalable without relying on heavy backend servers.

### 🤖 Edge Biometrics (Zero-Latency)
- **Client-Side Processing**: Powered by `face-api.js`, facial recognition models run directly inside the browser's WebGL context. No images are ever sent to a server for processing, ensuring ultra-fast validation and 100% privacy compliance.
- **Dynamic Thresholding**: Administrators can tune biometric confidence thresholds in real-time from the dashboard.

### ⚡ Serverless Cloud Infrastructure
- **Supabase Realtime**: Instantaneous data synchronization across devices using PostgreSQL and WebSockets.
- **Orphan-Proof Storage**: Automated cascading deletion protocols ensure that when a student updates their face or is removed, cloud storage buckets are instantly purged of dead data.

### 🛡️ Enterprise-Grade Data Integrity
- **Unified Schema Enforcement**: Rigid HTML structures and custom modals force data consistency (e.g., standardizing "Computer Science" across all inputs), eliminating database fragmentation.
- **Zombie Session Exterminator**: Decentralized background daemons continuously monitor active classes, automatically terminating abandoned or overtime sessions to keep analytics pristine.

### 📊 Advanced Matrix Analytics
- **Dynamic CSV Generation**: Bypasses standard database dumps to compile beautiful, grid-based Excel/CSV reports detailing exact "Present/Absent" statuses and total percentages for every student.
- **Real-Time Data Visualization**: Dashboard charts and live KPI cards provide instant administrative insights.

### 📱 Responsive & Fluid UI
- **Mobile-First Design**: Custom CSS Variables and CSS Grid architectures ensure the UI scales flawlessly—from small iPhones up to 4K Ultra-Wide monitors.
- **Dimming Overlays & Gestures**: Polished micro-interactions, sidebars, and dark-mode toggles provide a premium software experience.

---

## 🚀 Quick Start & Local Setup

Because the heavy lifting is handled by Supabase and client-side AI, deploying FaceAttend is effortless.

### 1. Clone & Serve
```bash
# Clone the repository
git clone https://github.com/2024f-mulug-1293-tech/Face-Attendence-SYS-CV.git
cd Face-Attendence-SYS-CV

# Serve the static files (A server is required due to CORS & WebGL requirements)
npx serve .
# OR using python:
python -m http.server 8000
```
*Visit `http://localhost:8000` in your browser.*

### 2. Configure Your Cloud Environment
1. Create a [Supabase](https://supabase.com/) project.
2. Initialize tables: `students`, `sessions`, `attendance_records`, `audit_log`, `users`.
3. Open `js/supabase-config.js` and paste your **Supabase URL** and **Anon Key**.

---

## 🌐 Production Deployment Guide

FaceAttend is a static SPA, making it eligible for lightning-fast, 100% free Edge deployment.

**Recommended Hosts:**
- [Vercel](https://vercel.com/) (Best Performance & GitHub Integration)
- [Cloudflare Pages](https://pages.cloudflare.com/)
- [Netlify](https://www.netlify.com/)

**Post-Deployment Checklist:**
1. Update your Supabase Auth `Redirect URLs` to include your new production domain.
2. Configure Google OAuth credentials in the Google Cloud Console with your new domain.

---

<div align="center">
  <h3>Built with ❤️ by <b>MUHAMMAD UMAIR ZAHID</b></h3>
  <i>Minhaj University Lahore</i>
</div>
