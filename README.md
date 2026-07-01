# 🎓 FaceAttend - AI Face Recognition Attendance System

**FaceAttend** is a blazing-fast, modern, and fully responsive student attendance management system built for **Minhaj University Lahore**. It uses real-time AI biometric facial recognition to automatically detect, verify, and mark students present.

Built with ❤️ by **MUHAMMAD UMAIR ZAHID**.

---

## ✨ Key Features

- **🤖 AI Facial Recognition**: Uses `face-api.js` for lightweight, in-browser facial detection and descriptor matching.
- **⚡ Cloud Sync**: Powered by Supabase (PostgreSQL & Storage) for instantaneous, real-time data syncing.
- **📱 Fully Responsive**: A custom CSS design system that flawlessly adapts from the smallest mobile screens up to ultrawide desktop monitors.
- **🧟 Zombie Session Cleanup**: Decentralized background logic automatically terminates stale or abandoned attendance sessions.
- **📊 Matrix Reporting**: Generates beautiful, grid-based CSV exports detailing complete semester attendance percentages.
- **🛡️ Strict Data Integrity**: Relies on unified dropdowns to prevent data fragmentation (No vulnerable free-text entries).
- **🗑️ Zero-Orphan Deletion**: Cascading architecture ensures images and Auth records are securely purged when a student is deleted.

---

## 🛠️ Technology Stack

- **Frontend**: Pure HTML5, Vanilla JavaScript, Custom CSS Variables
- **AI/Biometrics**: `face-api.js` (running entirely client-side via WebGL)
- **Backend/Database**: [Supabase](https://supabase.com/) (PostgreSQL)
- **Authentication**: Google OAuth + Email/Password via Supabase Auth
- **Storage**: Supabase Storage Buckets (for avatar/biometric images)

---

## 🚀 Quick Start / Local Setup

Because FaceAttend is a static Single Page Application (SPA) powered by a Backend-as-a-Service (Supabase), there is no heavy Node.js backend to configure.

### 1. Clone the repository
```bash
git clone https://github.com/2024f-mulug-1293-tech/Face-Attendence-SYS-CV.git
cd Face-Attendence-SYS-CV
```

### 2. Configure Supabase (If deploying your own backend)
1. Create a new Supabase project.
2. Ensure you have the `public.students`, `public.sessions`, and `public.attendance_records` tables configured.
3. Open `js/supabase-config.js` and insert your **Project URL** and **Anon Key**.

### 3. Run Locally
You must serve the files via a local web server (opening `index.html` directly via `file://` will block the camera and module imports due to CORS).
Using Python:
```bash
python -m http.server 8000
```
Or using Node/NPM:
```bash
npx serve .
```
Then visit `http://localhost:8000` in your browser.

---

## 🌐 Production Deployment

This application is ready for production and can be hosted completely free on **Vercel**, **Netlify**, or **Cloudflare Pages**.

1. Create a [Vercel](https://vercel.com/) account.
2. Click **Import Project** and link this GitHub repository.
3. Click **Deploy**.
4. *Important*: Add your new Vercel URL to your Supabase Auth **Redirect URLs** settings so Google Login works in production.

---

## 📄 License
This project is proprietary software developed for Minhaj University Lahore. All rights reserved.
