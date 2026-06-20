# Getting Started with Strumm ⏵

Follow these instructions to set up your local development environment for Strumm:

---

## Prerequisites
* **Node.js**: `v18+` or `v20+`
* **Python**: `3.11+`
* **pnpm**: `v9+` or `v10+`
* **MongoDB**: A running local instance or a MongoDB Atlas URI connection string.

---

## 1. Backend API Setup (`apps/api`)

1. Navigate to the API folder:
   ```bash
   cd strumm/apps/api
   ```
2. Create and activate a virtual environment:
   ```bash
   python -m venv venv
   # On Windows:
   .\venv\Scripts\activate
   # On macOS/Linux:
   source venv/bin/activate
   ```
3. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```
4. Create a `.env` file in the folder with the following variables:
   ```env
   MONGODB_URI=mongodb://localhost:27017/strumm
   GROQ_API_KEY=your_groq_api_key
   PODCAST_INDEX_API_KEY=your_podcast_index_api_key
   PODCAST_INDEX_API_SECRET=your_podcast_index_api_secret
   ```
5. Run the FastAPI development server:
   ```bash
   uvicorn app.main:app --reload --port 8000
   ```

---

## 2. Frontend Setup (`apps/web`)

1. Navigate to the monorepo root:
   ```bash
   cd strumm
   ```
2. Install monorepo dependencies:
   ```bash
   pnpm install
   ```
3. Create a `.env` file inside `apps/web/` containing:
   ```env
   NEXT_PUBLIC_API_URL=http://localhost:8000
   ```
4. Start the Turborepo development server:
   ```bash
   pnpm run dev
   ```
5. Open [http://localhost:3000](http://localhost:3000) in your browser.
