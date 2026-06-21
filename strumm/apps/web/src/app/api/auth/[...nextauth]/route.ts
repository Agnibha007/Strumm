import NextAuth from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import { apiUrl } from "web/lib/api";

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
          // Sync with our FastAPI backend database
          const response = await fetch(apiUrl("/auth/google"), {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            credentials: "include",
            body: JSON.stringify({
              idToken: account.id_token,
            }),
          });
          
          const json = await response.json();
          if (json.success && json.data) {
            token.accessToken = json.data.token;
            // Trim user object to avoid NextAuth cookie blooming over Vercel's 14KB limit
            token.strummUser = {
              id: json.data.user.id,
              username: json.data.user.username,
              email: json.data.user.email,
              displayName: json.data.user.displayName,
              avatar: json.data.user.avatar,
              role: json.data.user.role
            };
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
