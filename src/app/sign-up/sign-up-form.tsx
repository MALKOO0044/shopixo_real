"use client";

import { createClientComponentClient } from "@supabase/auth-helpers-nextjs";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function SignUpForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const supabase = createClientComponentClient();

  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    const envSiteUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim() || "";
    const browserOrigin = typeof window !== "undefined" ? window.location.origin : "";
    const resolvedBase = (browserOrigin && /^https?:\/\//i.test(browserOrigin)
      ? browserOrigin
      : envSiteUrl && /^https?:\/\//i.test(envSiteUrl)
        ? envSiteUrl
        : "http://localhost:3000").replace(/\/$/, "");
    const callbackUrl = `${resolvedBase}/auth/callback`;

    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: callbackUrl,
      },
    });

    if (error) {
      setError(error.message);
    } else {
      setSuccess(true);
    }
  };

  if (success) {
    return (
      <div className="rounded-md bg-primary/10 p-6 text-center">
        <h2 className="text-lg font-semibold">Check Your Email</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          We sent a confirmation link to your email. Please click the link to complete registration.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSignUp} className="space-y-4">
      {error && <p className="rounded-md bg-destructive/10 p-3 text-center text-sm text-destructive">{error}</p>}
      <div className="space-y-1">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          dir="ltr"
          required
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          dir="ltr"
          required
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="confirmPassword">Confirm Password</Label>
        <Input
          id="confirmPassword"
          type="password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          dir="ltr"
          required
        />
      </div>
      <Button type="submit" className="w-full">Create Account</Button>
    </form>
  );
}
