// ===============================
// server.js — FINAL FIXED VERSION
// ===============================

import dotenv from "dotenv";
dotenv.config();

import express from "express";
import mongoose from "mongoose";
import path from "path";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import cookieParser from "cookie-parser";
import fetch from "node-fetch";

const app = express();
const __dirname = path.resolve();

// ------------------------------
// Middleware
// ------------------------------
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// ------------------------------
// Env Vars
// ------------------------------
const {
  MONGO_URI,
  JWT_SECRET,
  GEMINI_API_KEY,
  PORT = 5000
} = process.env;

// ------------------------------
// DB Connection
// ------------------------------
mongoose
  .connect(MONGO_URI)
  .then(() => console.log("MongoDB connected"))
  .catch((err) => {
    console.error("MongoDB error:", err);
    process.exit(1);
  });

// ------------------------------
// Models
// ------------------------------
const UserSchema = new mongoose.Schema({
  name: String,
  email: { type: String, unique: true },
  phone: String,
  college_name: String,
  course: String,
  password: String,
});

const User = mongoose.model("User", UserSchema);

const AssessmentSchema = new mongoose.Schema({
  answers: Object,
  aiAnalysis: String,
  createdAt: { type: Date, default: Date.now }
});

const Assessment = mongoose.model("Assessment", AssessmentSchema);

// ------------------------------
// JWT Helpers
// ------------------------------
function signToken(user) {
  return jwt.sign(
    { _id: user._id, name: user.name, email: user.email },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}

const cookieOpts = {
  httpOnly: true,
  sameSite: "lax",
  secure: false,
};

// ------------------------------
// Gemini Text Extraction
// ------------------------------
function extractGeminiText(data) {
  try {
    const candidate = data?.candidates?.[0];
    const parts =
      candidate?.content?.parts ||
      candidate?.content?.[0]?.parts;

    if (!parts) {
      return `⚠ No parts array found. finishReason: ${
        candidate?.finishReason ?? "unknown"
      }`;
    }

    return parts
      .map((p) => p.text || JSON.stringify(p))
      .join("\n\n")
      .trim();
  } catch (err) {
    return "❌ Error extracting AI text: " + err.message;
  }
}

// ------------------------------
// Auth Middleware
// ------------------------------
function isAuthenticated(req, res, next) {
  const token = req.cookies.token;
  if (!token) return res.redirect("/");

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.redirect("/");
  }
}

// ------------------------------
// Compact Answers (Token Saving)
// ------------------------------
function compactAnswers(obj) {
  return Object.entries(obj)
    .map(([key, value]) => `${key}: ${String(value).trim()}`)
    .join("\n");
}

// ------------------------------
// Routes
// ------------------------------
app.get("/", (req, res) => res.render("login", { error: null }));
app.get("/signup", (req, res) => res.render("signup", { error: null }));

app.post("/signup", async (req, res) => {
  const { name, email, phone, college_name, course, password } = req.body;

  try {
    const exists = await User.findOne({ email });
    if (exists) return res.render("signup", { error: "Email already exists!" });

    if (!password || password.length < 6)
      return res.render("signup", { error: "Password too short!" });

    const hashed = await bcrypt.hash(password, 10);

    const user = await User.create({
      name,
      email,
      phone,
      college_name,
      course,
      password: hashed,
    });

    res.cookie("token", signToken(user), cookieOpts);
    return res.redirect("/dashboard");
  } catch (err) {
    console.error(err);
    res.render("signup", { error: "Signup error" });
  }
});

app.post("/login", async (req, res) => {
  const { email, password } = req.body;

  try {
    const user = await User.findOne({ email });
    if (!user) return res.render("login", { error: "User not found" });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.render("login", { error: "Wrong password" });

    res.cookie("token", signToken(user), cookieOpts);
    return res.redirect("/dashboard");
  } catch (err) {
    console.error(err);
    res.render("login", { error: "Login error" });
  }
});

app.get("/dashboard", isAuthenticated, (req, res) =>
  res.render("dashboard", { user: req.user })
);

// ------------------------------
// Assessment Page
// ------------------------------
app.get("/assessment", isAuthenticated, (req, res) => {
  res.render("assessment");
});

// ------------------------------
// Assessment Submit + Gemini AI
// ------------------------------
app.post("/assessment", isAuthenticated, async (req, res) => {
  try {
    const compacted = compactAnswers(req.body);

    const prompt = `
You are an expert AI career counselor.

Analyze the user's responses and produce:

1. Personality type (2 lines)
2. Skill strengths & weaknesses
3. Top 3 career matches with short reasons
4. 3-month + 6-month learning roadmap
5. Recommended tools & courses

User Answers:
${compacted}

Return a clean, readable report.
`;

    // Store assessment BEFORE calling AI
    const doc = await Assessment.create({
      answers: req.body,
      aiAnalysis: "",
    });

    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

    const body = {
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }],
        },
      ],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 6144,
      },
    };

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data = await response.json();

    console.log("AI RAW:", JSON.stringify(data, null, 2));

    let analysis = extractGeminiText(data);

    const finish = data?.candidates?.[0]?.finishReason;
    if (finish === "MAX_TOKENS") {
      analysis +=
        "\n\n⚠ AI response was truncated (MAX_TOKENS). Increase maxOutputTokens for longer output.";
    }

    doc.aiAnalysis = analysis;
    await doc.save();

    return res.render("assessment-result", { analysis });
  } catch (err) {
    console.error("Assessment Error:", err);
    return res.render("assessment-result", {
      analysis: "Server error during AI analysis. Try again later.",
    });
  }
});

// ------------------------------
// Logout
// ------------------------------
app.get("/logout", (req, res) => {
  res.clearCookie("token");
  res.redirect("/");
});

// ------------------------------
// Start Server
// ------------------------------
app.listen(PORT, () =>
  console.log(`🚀 Server running at http://localhost:${PORT}`)
);
