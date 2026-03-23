"use client"

import { createClientComponentClient } from "@supabase/auth-helpers-nextjs"
import { useSearchParams } from "next/navigation"
import { useState, useTransition, useEffect } from "react"

export default function ForgotPasswordForm() {
  const supabase = createClientComponentClient()
  const params = useSearchParams()
  const [email, setEmail] = useState("")
  const [message, setMessage] = useState("")
  const [error, setError] = useState("")
  const [pending, startTransition] = useTransition()

  useEffect(() => {
    const e = params?.get("email") || ""
    if (e) setEmail(e)
  }, [params])

  const envSiteUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim() || ""
  const browserOrigin = typeof window !== "undefined" ? window.location.origin : ""
  const base = (browserOrigin && /^https?:\/\//i.test(browserOrigin)
    ? browserOrigin
    : envSiteUrl && /^https?:\/\//i.test(envSiteUrl)
      ? envSiteUrl
      : "http://localhost:3000").replace(/\/$/, "")
  const nextParam = (params?.get("redirect") || params?.get("next") || "/").toString()
  const safeNext = nextParam.startsWith("/") && !nextParam.startsWith("//") ? nextParam : "/"
  const targetAfterCallback = safeNext && safeNext !== "/" ? `/reset-password?next=${encodeURIComponent(safeNext)}` : "/reset-password"
  const redirectTo = `${base}/auth/callback?next=${encodeURIComponent(targetAfterCallback)}`

  function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError("")
    setMessage("")
    if (!email) { setError("Please enter your email address"); return }
    startTransition(async () => {
      const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo })
      if (error) setError(error.message)
      else setMessage(`Reset link sent to ${email}. Please check your inbox.`)
    })
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <h2 className="text-center text-2xl font-bold">Reset Password</h2>
      <div className="grid gap-2">
        <label className="text-sm">Email</label>
        <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="rounded-full border px-4 py-3" placeholder="example@email.com" />
      </div>
      <button disabled={pending} className="w-full h-12 rounded-full bg-black text-white text-sm font-semibold hover:opacity-95">Send Reset Link</button>
      {message && <div className="rounded-md border border-emerald-500 bg-emerald-50 p-2 text-sm text-emerald-700">{message}</div>}
      {error && <div className="rounded-md border border-destructive bg-destructive/10 p-2 text-sm text-destructive">{error}</div>}
    </form>
  )
}
