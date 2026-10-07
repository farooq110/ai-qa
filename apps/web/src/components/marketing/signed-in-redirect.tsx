"use client";

import { useEffect } from "react";

/**
 * On the marketing home: if a session token exists, the visitor is a returning
 * user — send them straight to the app instead of the pitch.
 */
export function SignedInRedirect() {
  useEffect(() => {
    if (window.localStorage.getItem("proofline.accessToken")) {
      window.location.replace("/dashboard");
    }
  }, []);
  return null;
}
