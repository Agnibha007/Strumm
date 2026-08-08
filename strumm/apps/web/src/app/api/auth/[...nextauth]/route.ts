import NextAuth from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import { API_ORIGIN } from "web/lib/api";

const handler = NextAuth({
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID || "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
    }),
  ],
  callbacks: {
    async jwt({ token, account, user }) {
      if (account && user) {
        try {
          if (!account.id_token) {
            throw new Error("Google did not return an ID token.");
          }
          // Sync with our FastAPI backend database. This runs on the server
          // (no CORS), so call the API origin directly — apiUrl() returns a
          // relative /proxy path that only the browser can use.
          const response = await fetch(`${API_ORIGIN}/auth/google`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              idToken: account.id_token,
            }),
          });
          
          if (!response.ok) {
            console.error(
              "Strumm Auth: Backend API returned HTTP", response.status,
              "for Google OAuth sync. Check that the API has GOOGLE_CLIENT_ID configured.",
            );
            // Still try to parse JSON body for error details
            try {
              const errBody = await response.json();
              if (errBody.error) {
                console.error("Strumm Auth: API error detail:", errBody.error);
              }
            } catch (_) {}
          } else {
            const json = await response.json();
            if (json.success && json.data) {
              token.accessToken = json.data.token;
              token.refreshToken = json.data.refreshToken;
              // Trim user object to avoid NextAuth cookie blooming over Vercel's 14KB limit
              token.strummUser = {
                id: json.data.user.id,
                username: json.data.user.username,
                email: json.data.user.email,
                displayName: json.data.user.displayName,
                avatar: json.data.user.avatar,
                role: json.data.user.role
              };
            } else {
              console.error(
                "Strumm Auth: Backend API rejected Google OAuth:",
                json.error || "Unknown error (no success flag)",
              );
            }
          }
        } catch (e) {
          console.error("Strumm Auth: Failed to sync Google OAuth with FastAPI server", e);
        }
      }
      return token;
    },
    async session({ session, token }) {
      // Expose custom token and backend user data to client components
      (session as any).accessToken = token.accessToken;
      (session as any).refreshToken = token.refreshToken;
      if (token.strummUser) {
        session.user = token.strummUser as any;
      }
      return session;
    },
  },
  pages: {
    signIn: "/",
  },
  secret: process.env.NEXTAUTH_SECRET,
});

export { handler as GET, handler as POST };
