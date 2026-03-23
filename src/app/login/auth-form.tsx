"use client"

import { createClientComponentClient } from "@supabase/auth-helpers-nextjs"
import { useMemo, useState, useTransition } from "react"
import { useSearchParams } from "next/navigation"
import { Facebook, Smartphone, Eye, EyeOff } from "lucide-react"

type Step = "email" | "password" | "verify_code" | "onboarding" | "phone"

export default function AuthForm() {
  const supabase = createClientComponentClient()
  const searchParams = useSearchParams()
  const nextParam = (searchParams?.get("redirect") || searchParams?.get("next") || "/").toString()
  const safeNext = nextParam.startsWith("/") && !nextParam.startsWith("//") ? nextParam : "/"
  
  // Helper to validate URLs - filter out development addresses
  const isValidUrl = (url: string) => {
    if (!url) return false
    if (url.includes("0.0.0.0")) return false
    if (url.includes("127.0.0.1")) return false
    if (url.includes("localhost") && !url.includes("localhost.")) return false
    return url.startsWith("https://") || url.startsWith("http://")
  }
  
  const envSiteUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim() || ""
  const browserOrigin = typeof window !== "undefined" ? window.location.origin : ""
  const base = (isValidUrl(browserOrigin) ? browserOrigin : isValidUrl(envSiteUrl) ? envSiteUrl : "http://localhost:3000").replace(/\/$/, "")
  const redirectTo = `${base}/auth/callback`
  const redirectWithNext = safeNext && safeNext !== "/" ? `${redirectTo}?next=${encodeURIComponent(safeNext)}` : redirectTo

  const [step, setStep] = useState<Step>("email")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [showPw, setShowPw] = useState(false)
  const [code, setCode] = useState("")
  const [fullName, setFullName] = useState("")
  const [birthday, setBirthday] = useState("")
  const [info, setInfo] = useState<string>("")
  const [error, setError] = useState<string>("")
  const [pending, startTransition] = useTransition()
  const [emailExists, setEmailExists] = useState<boolean | null>(null)

  const titleByStep = useMemo(() => {
    switch (step) {
      case "email":
        return "Sign In or Create Account"
      case "password":
        return emailExists === false ? "Create Password" : "Enter Password"
      case "verify_code":
        return "Check Your Email"
      case "onboarding":
        return "Tell Us About You"
      case "phone":
        return "Sign In with Phone"
      default:
        return ""
    }
  }, [step, emailExists])

  function resetMessages() {
    setError("")
    setInfo("")
  }

  function handleContinueFromEmail(e: React.FormEvent) {
    e.preventDefault()
    resetMessages()
    if (!email) {
      setError("Please enter your email address")
      return
    }
    startTransition(async () => {
      try {
        const res = await fetch("/api/auth/check-email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email }),
        })
        if (res.ok) {
          const j = await res.json()
          if (typeof j.exists === "boolean") {
            setEmailExists(j.exists)
          } else {
            setEmailExists(null)
          }
        } else {
          setEmailExists(null)
        }
      } catch {
        setEmailExists(null)
      }
      setStep("password")
    })
  }

  function heading(h: string) {
    return (
      <h2 className="mb-4 text-center text-2xl font-bold">{h}</h2>
    )
  }

  async function handlePasswordSubmit(e: React.FormEvent) {
    e.preventDefault()
    resetMessages()
    if (!email || !password) {
      setError("Please enter email and password")
      return
    }

    startTransition(async () => {
      if (emailExists === true) {
        const { data, error: signInErr } = await supabase.auth.signInWithPassword({ email, password })
        if (!signInErr && data?.user) {
          if (typeof window !== "undefined") window.location.replace(safeNext)
          return
        }
        setError("Incorrect password. Please try again or use the password recovery option.")
        return
      }

      if (emailExists === false) {
        if (password.length < 8) {
          setError("Password must be at least 8 characters")
          return
        }
        const { error: otpErr } = await supabase.auth.signInWithOtp({
          email,
          options: { emailRedirectTo: redirectWithNext, shouldCreateUser: true },
        })
        if (!otpErr) {
          setInfo(`Verification code sent to ${email}.`)
          setStep("verify_code")
          return
        }
        const { error: suErr } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: redirectWithNext },
        })
        if (!suErr) {
          setInfo(`Confirmation email sent to ${email}. Please check your inbox and click "Confirm Email" to complete registration.`)
          return
        }
        setError(suErr?.message || otpErr?.message || "Failed to send verification code")
        return
      }

      const { data, error: signInErr } = await supabase.auth.signInWithPassword({ email, password })
      if (!signInErr && data?.user) {
        if (typeof window !== "undefined") window.location.replace(safeNext)
        return
      }
      const { error: otpErr2 } = await supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: redirectWithNext, shouldCreateUser: true },
      })
      if (!otpErr2) {
        setInfo(`Verification code sent to ${email}.`)
        setStep("verify_code")
        return
      }
      const { error: suErr2 } = await supabase.auth.signUp({ email, password, options: { emailRedirectTo: redirectWithNext } })
      if (!suErr2) {
        setInfo(`Confirmation email sent to ${email}. Please check your inbox and click "Confirm Email".`)
        return
      }
      setError(suErr2?.message || otpErr2?.message || "An unexpected error occurred")
    })
  }

  async function handleVerifyCode(e: React.FormEvent) {
    e.preventDefault()
    resetMessages()
    if (!code || code.length < 6) {
      setError("Please enter the 6-digit code")
      return
    }

    startTransition(async () => {
      const { error: verifyErr } = await supabase.auth.verifyOtp({
        email,
        token: code,
        type: "email",
      })
      if (verifyErr) {
        setError(verifyErr.message)
        return
      }

      if (emailExists === false && password && password.length >= 8) {
        const { error: pwdErr } = await supabase.auth.updateUser({ password })
        if (pwdErr) { setError(pwdErr.message); return }
      }

      setStep("onboarding")
    })
  }

  async function handleResend() {
    resetMessages()
    startTransition(async () => {
      const { error: otpErr } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: redirectWithNext, shouldCreateUser: true } })
      if (otpErr) setError(otpErr.message)
      else setInfo("Verification code resent to your email.")
    })
  }

  function parseBirthday(input: string): string | null {
    const m = input.match(/^\s*(\d{2})\/(\d{2})\/(\d{4})\s*$/)
    if (!m) return null
    const mm = Number(m[1])
    const dd = Number(m[2])
    const yyyy = Number(m[3])
    const d = new Date(yyyy, mm - 1, dd)
    if (d.getFullYear() !== yyyy || d.getMonth() !== mm - 1 || d.getDate() !== dd) return null
    return `${yyyy.toString().padStart(4, "0")}-${mm.toString().padStart(2, "0")}-${dd.toString().padStart(2, "0")}`
  }

  async function handleOnboarding(e: React.FormEvent) {
    e.preventDefault()
    resetMessages()
    if (!fullName.trim()) {
      setError("Please enter your full name")
      return
    }
    const iso = parseBirthday(birthday)
    if (!iso) {
      setError("Please enter a valid date in MM/DD/YYYY format")
      return
    }

    startTransition(async () => {
      const { error: updErr } = await supabase.auth.updateUser({
        data: { full_name: fullName.trim(), birthday: iso },
      })
      if (updErr) {
        setError(updErr.message)
        return
      }
      if (typeof window !== "undefined") window.location.replace(safeNext === "/" ? "/account" : safeNext)
    })
  }

  async function handleOAuth(provider: "google" | "facebook") {
    setError(''); setInfo('')
    const options: { redirectTo: string; scopes?: string; queryParams?: Record<string, string> } = { redirectTo: redirectWithNext }
    if (provider === 'facebook') {
      options.scopes = 'email public_profile'
      options.queryParams = { auth_type: 'rerequest' }
    }
    if (provider === 'google') {
      options.queryParams = { prompt: 'select_account' }
    }
    const { error } = await supabase.auth.signInWithOAuth({ provider, options })
    if (error) {
      const msg = (error.message || '').toLowerCase()
      if (msg.includes('unsupported provider') || msg.includes('not enabled')) {
        setError(`${provider === 'google' ? 'Google' : 'Facebook'} provider is not enabled in Supabase settings. Please enable it and add OAuth credentials.`)
      } else {
        setError(error.message)
      }
    }
  }

  const [phone, setPhone] = useState("")
  const [phoneCode, setPhoneCode] = useState("")
  const [phoneSent, setPhoneSent] = useState(false)

  async function handlePhoneSend(e: React.FormEvent) {
    e.preventDefault(); resetMessages()
    startTransition(async () => {
      const { error } = await supabase.auth.signInWithOtp({ phone })
      if (error) setError(error.message); else setPhoneSent(true)
    })
  }
  async function handlePhoneVerify(e: React.FormEvent) {
    e.preventDefault(); resetMessages()
    startTransition(async () => {
      const { error } = await supabase.auth.verifyOtp({ phone, token: phoneCode, type: "sms" })
      if (error) setError(error.message); else if (typeof window !== "undefined") window.location.replace(safeNext)
    })
  }

  function PillButton({ children, variant = "outline", onClick, disabled }: { children: React.ReactNode; variant?: "outline" | "solid"; onClick?: () => void; disabled?: boolean }) {
    const common = "w-full h-12 rounded-full px-4 text-sm font-semibold transition focus:outline-none focus:ring-2 focus:ring-offset-2"
    const cls = variant === "solid"
      ? `${common} bg-[#1a73e8] text-white hover:opacity-95 focus:ring-[#1a73e8]`
      : `${common} border hover:bg-accent`
    return (
      <button type="button" onClick={onClick} disabled={disabled} className={cls}>
        <div className="flex items-center justify-between">
          {children}
        </div>
      </button>
    )
  }

  return (
    <div className="space-y-5">
      {heading(titleByStep)}

      {step === "email" && (
        <form onSubmit={handleContinueFromEmail} className="space-y-3">
          <div className="grid gap-2">
            <label className="text-sm">Email</label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="rounded-full border px-4 py-3"
              placeholder="example@email.com"
            />
          </div>
          <button disabled={pending} className="w-full h-12 rounded-full bg-black text-white text-sm font-semibold hover:opacity-95">
            Continue
          </button>
        </form>
      )}

      {step === "password" && (
        <form onSubmit={handlePasswordSubmit} className="space-y-3">
          <div className="rounded-full bg-gray-100 px-4 py-2 text-sm text-gray-700 flex items-center justify-between">
            <span className="truncate">{email}</span>
            <button type="button" className="underline" onClick={() => setStep("email")}>Edit</button>
          </div>
          <div className="grid gap-2">
            <label className="text-sm">{emailExists === false ? "Create Password" : "Password"}</label>
            <div className="relative">
              <input
                type={showPw ? "text" : "password"}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-full border px-4 py-3 pr-12"
                placeholder="••••••••"
              />
              <button type="button" onClick={() => setShowPw((v) => !v)} className="absolute inset-y-0 right-3 flex items-center text-gray-500">
                {showPw ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
              </button>
            </div>
          </div>
          <div className="flex items-center justify-between text-sm">
            <div />
            {emailExists !== false && (
              <a
                href={`/forgot-password${safeNext && safeNext !== "/" ? `?next=${encodeURIComponent(safeNext)}` : ""}${email ? `${safeNext && safeNext !== "/" ? "&" : "?"}email=${encodeURIComponent(email)}` : ""}`}
                className="text-blue-600 hover:underline"
              >
                Forgot password?
              </a>
            )}
          </div>
          <button disabled={pending} className="w-full h-12 rounded-full bg-black text-white text-sm font-semibold hover:opacity-95">
            Continue
          </button>
          {emailExists === false && (
            <p className="text-xs text-gray-500 text-center">A new account will be created for this email.</p>
          )}
        </form>
      )}

      {step === "verify_code" && (
        <form onSubmit={handleVerifyCode} className="space-y-3">
          <p className="text-center text-sm text-gray-600">Enter the verification code we sent to {email}</p>
          <input
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={6}
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className="w-full rounded-full border px-4 py-3 text-center tracking-widest"
            placeholder="Code"
          />
          <button disabled={pending} className="w-full h-12 rounded-full bg-black text-white text-sm font-semibold hover:opacity-95">
            Continue
          </button>
          <div className="text-center">
            <button type="button" onClick={handleResend} className="text-sm text-blue-600 hover:underline">Resend Email</button>
          </div>
        </form>
      )}

      {step === "onboarding" && (
        <form onSubmit={handleOnboarding} className="space-y-4">
          <div className="grid gap-2">
            <label className="text-sm">Full Name</label>
            <input
              type="text"
              required
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              className="rounded-full border px-4 py-3"
              placeholder="Full Name"
            />
          </div>
          <div className="grid gap-2">
            <label className="text-sm">Date of Birth</label>
            <input
              type="text"
              required
              value={birthday}
              onChange={(e) => setBirthday(e.target.value)}
              className="rounded-full border px-4 py-3"
              placeholder="MM/DD/YYYY"
            />
          </div>
          <p className="text-xs text-gray-600 text-center">
            By clicking "Continue", you agree to our Terms of Service and have read our Privacy Policy.
          </p>
          <button disabled={pending} className="w-full h-12 rounded-full bg-black text-white text-sm font-semibold hover:opacity-95">
            Continue
          </button>
        </form>
      )}

      {step === "email" && (
        <div className="flex items-center gap-4 text-sm text-gray-500">
          <div className="h-px flex-1 bg-gray-200" />
          <span>or</span>
          <div className="h-px flex-1 bg-gray-200" />
        </div>
      )}

      {step === "email" && (
        <div className="space-y-3">
          <PillButton variant="solid" onClick={() => handleOAuth("google")} disabled={pending}>
            <GoogleIcon />
            <span className="flex-1 text-center">Continue with Google</span>
          </PillButton>
          <PillButton onClick={() => handleOAuth("facebook")} disabled={pending}>
            <Facebook className="h-5 w-5 text-[#1877f2]" />
            <span className="flex-1 text-center">Continue with Facebook</span>
          </PillButton>
          <PillButton onClick={() => setStep("phone")} disabled={pending}>
            <Smartphone className="h-5 w-5" />
            <span className="flex-1 text-center">Continue with Phone</span>
          </PillButton>
        </div>
      )}

      {step === "phone" && (
        <div className="space-y-3">
          <form onSubmit={handlePhoneSend} className="grid gap-2">
            <label className="text-sm">Phone Number (e.g., +1555xxxxxxx)</label>
            <input type="tel" required value={phone} onChange={(e) => setPhone(e.target.value)} className="rounded-full border px-4 py-3" />
            <button disabled={pending} className="w-full h-12 rounded-full bg-black text-white text-sm font-semibold hover:opacity-95">Send Code</button>
          </form>
          {phoneSent && (
            <form onSubmit={handlePhoneVerify} className="grid gap-2">
              <label className="text-sm">Enter Verification Code</label>
              <input inputMode="numeric" pattern="[0-9]*" maxLength={6} required value={phoneCode} onChange={(e) => setPhoneCode(e.target.value)} className="rounded-full border px-4 py-3" />
              <button disabled={pending} className="w-full h-12 rounded-full bg-black text-white text-sm font-semibold hover:opacity-95">Confirm</button>
            </form>
          )}
          <div className="text-center">
            <button type="button" className="text-sm text-blue-600 hover:underline" onClick={() => setStep("email")}>Back</button>
          </div>
        </div>
      )}

      {(error || info) && (
        <div className="space-y-2">
          {error && <div className="rounded-md border border-destructive bg-destructive/10 p-2 text-sm text-destructive">{error}</div>}
          {info && <div className="rounded-md border border-emerald-500 bg-emerald-50 p-2 text-sm text-emerald-700">{info}</div>}
        </div>
      )}
    </div>
  )
}

function GoogleIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden className="mr-1">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.9 33.7 29.4 37 24 37c-7.2 0-13-5.8-13-13s5.8-13 13-13c3.3 0 6.3 1.2 8.6 3.2l5.7-5.7C34.6 5.1 29.6 3 24 3 12.4 3 3 12.4 3 24s9.4 21 21 21 21-9.4 21-21c0-1.2-.1-2.3-.4-3.5z"/>
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 16.2 18.9 13 24 13c3.3 0 6.3 1.2 8.6 3.2l5.7-5.7C34.6 5.1 29.6 3 24 3 15.3 3 7.8 8.1 6.3 14.7z"/>
      <path fill="#4CAF50" d="M24 45c5.3 0 10.2-2 13.8-5.2l-6.4-5.3C29.2 35.7 26.8 36.5 24 36.5 18.7 36.5 14.1 33.1 12.4 28l-6.4 5C8.4 39.9 15.6 45 24 45c9.9 0 18.4-6.9 21-16.1.3-1.2.4-2.3.4-3.5 0-1-.1-1.9-.3-2.9z"/>
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.7-6 8-11.3 8-5.3 0-9.9-3.4-11.6-8.5l-6.4 5C8.4 39.9 15.6 45 24 45c9.9 0 18.4-6.9 21-16.1.3-1.2.4-2.3.4-3.5 0-1-.1-1.9-.3-2.9z"/>
    </svg>
  )
}
