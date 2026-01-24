"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useRouter } from "next/navigation";

export default function AuthPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    // If already logged in, go to app
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) router.replace("/app");
    });
  }, [router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    setLoading(true);

    try {
      if (mode === "signup") {
        const { error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        setMsg("Signed up! Now sign in (or check email if confirmation is on).");
        setMode("signin");
      } else {
        const { error } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (error) throw error;
        router.replace("/app");
      }
    } catch (err: any) {
      setMsg(err?.message ?? "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="p-8 max-w-md">
      <h1 className="text-2xl font-semibold">commitAI</h1>
      <p className="mt-2 text-sm text-gray-600">
        {mode === "signin" ? "Sign in to continue" : "Create an account"}
      </p>

      <form onSubmit={handleSubmit} className="mt-6 space-y-3">
        <input
          className="w-full border rounded px-3 py-2"
          placeholder="Email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <input
          className="w-full border rounded px-3 py-2"
          placeholder="Password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />

        <button
          className="w-full border rounded px-3 py-2"
          disabled={loading}
          type="submit"
        >
          {loading
            ? "Working..."
            : mode === "signin"
            ? "Sign In"
            : "Sign Up"}
        </button>

        {msg && <p className="text-sm">{msg}</p>}
      </form>

      <div className="mt-4 text-sm">
        {mode === "signin" ? (
          <button className="underline" onClick={() => setMode("signup")}>
            Need an account? Sign up
          </button>
        ) : (
          <button className="underline" onClick={() => setMode("signin")}>
            Already have an account? Sign in
          </button>
        )}
      </div>
    </main>
  );
}
