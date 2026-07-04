import os
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
import logging

logger = logging.getLogger("strumm-email")

# Load SMTP variables from environment
SMTP_SERVER = os.getenv("SMTP_SERVER", "smtp.gmail.com")
SMTP_PORT = int(os.getenv("SMTP_PORT", "587"))
SENDER_EMAIL = os.getenv("SENDER_EMAIL", "")
SENDER_PASSWORD = os.getenv("SENDER_PASSWORD", "")

# Email domain for the sender address
EMAIL_DOMAIN = os.getenv("STRUMM_EMAIL_DOMAIN", "strumm.me")
SENDER_FROM = os.getenv("SENDER_FROM", f"Strumm <no-reply@{EMAIL_DOMAIN}>")

# ─── Brand tokens ───────────────────────────────────────────────────────

BRAND = {
    "primary": "#FF5500",
    "primary_hover": "#FF7733",
    "accent": "#C6A15B",
    "bg": "#080808",
    "surface": "#121212",
    "elevated": "#1A1A1A",
    "text": "#FFFFFF",
    "muted": "#8E8E93",
    "border": "#222222",
    "success": "#10B981",
    "error": "#EF4444",
    "radius": "12px",
}


# ─── HTML template parts ───────────────────────────────────────────────

def _head() -> str:
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="dark" />
  <meta name="supported-color-schemes" content="dark" />
  <!--[if mso]>
  <xml>
    <o:OfficeDocumentSettings>
      <o:AllowPNG/>
      <o:PixelsPerInch>96</o:PixelsPerInch>
    </o:OfficeDocumentSettings>
  </xml>
  <![endif]-->
  <style>
    @media only screen and (max-width:480px) {{
      .email-container {{ padding: 20px 12px !important; }}
      .email-content {{ padding: 24px 16px !important; }}
      .email-otp {{ font-size: 32px !important; letter-spacing: 6px !important; padding: 12px 16px !important; }}
      .email-button {{ padding: 12px 24px !important; font-size: 14px !important; }}
      .email-section {{ padding: 16px !important; }}
    }}
    @media (prefers-color-scheme: dark) {{
      .email-body {{ background-color: {BRAND["bg"]} !important; }}
      .email-content {{ background-color: {BRAND["surface"]} !important; border-color: {BRAND["border"]} !important; }}
    }}
  </style>
</head>
<body class="email-body" style="margin:0;padding:0;background-color:{BRAND['bg']};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Oxygen,Ubuntu,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:{BRAND['bg']};">
<tr><td align="center" style="padding:48px 16px;">
  <table role="presentation" width="100%" style="max-width:480px;" class="email-container">"""


def _logo() -> str:
    return f"""  <tr><td style="text-align:center;padding-bottom:24px;">
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto;">
    <tr>
      <td style="width:44px;height:44px;background:linear-gradient(135deg,{BRAND['primary']},#FF8833);border-radius:12px;text-align:center;vertical-align:middle;">
        <span style="font-size:22px;line-height:44px;font-weight:800;color:{BRAND['bg']};font-family:Georgia,'Times New Roman',serif;">S</span>
      </td>
    </tr>
    </table>
    <h1 style="font-size:30px;font-weight:700;color:{BRAND['text']};margin:12px 0 2px 0;font-family:Georgia,'Times New Roman',serif;letter-spacing:-0.5px;">Strumm</h1>
    <p style="font-size:10px;letter-spacing:2.5px;color:{BRAND['accent']};font-weight:600;margin:0;text-transform:uppercase;">Where your music lives.</p>
  </td></tr>"""


def _content_open() -> str:
    return f"""  <tr><td class="email-content" style="background-color:{BRAND['surface']};border:1px solid {BRAND['border']};border-radius:{BRAND['radius']};padding:36px 32px;text-align:center;">"""


def _content_close() -> str:
    return "  </td></tr>"


def _footer() -> str:
    return f"""  <tr><td style="text-align:center;padding-top:32px;">
    <p style="font-size:11px;color:{BRAND['muted']};margin:0 0 4px 0;line-height:1.6;">
      Strumm &mdash; Where your music lives.
    </p>
    <p style="font-size:10px;color:{BRAND['muted']};margin:0;line-height:1.5;">
      You received this email because of activity on your Strumm account.<br/>
      If you did not request this, you can safely ignore it.
    </p>
  </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>"""


def _divider() -> str:
    return f"""<hr style="border:none;border-top:1px solid {BRAND['border']};margin:24px 0;" />"""


def _otp_code_block(code: str) -> str:
    """Render a centered OTP code block with copy-friendly styling."""
    return f"""<div class="email-otp" style="display:inline-block;background-color:{BRAND['elevated']};border:1px solid {BRAND['border']};border-radius:10px;padding:18px 36px;margin:20px 0;">
  <span style="font-family:'SF Mono','Consolas','Courier New',monospace;font-size:40px;font-weight:700;color:{BRAND['text']};letter-spacing:10px;">{code}</span>
</div>"""


def _cta_button(link: str, label: str) -> str:
    """Render a prominent CTA button with hover fallback."""
    return f"""<div style="margin:28px 0;">
  <!--[if mso]>
  <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="{link}" style="height:48px;v-text-anchor:middle;width:240px;" arcsize="12" strokecolor="{BRAND['primary']}" fillcolor="{BRAND['primary']}">
    <w:anchorlock/>
    <center style="color:{BRAND['text']};font-family:Georgia,'Times New Roman',serif;font-size:15px;font-weight:700;">{label}</center>
  </v:roundrect>
  <![endif]-->
  <!--[if !mso]><!-->
  <a href="{link}" class="email-button" style="display:inline-block;background-color:{BRAND['primary']};color:{BRAND['text']};font-family:Georgia,'Times New Roman',serif;font-size:15px;font-weight:700;padding:14px 40px;border-radius:10px;text-decoration:none;box-shadow:0 4px 16px rgba(255,85,0,0.3);">
    {label}
  </a>
  <!--<![endif]-->
</div>"""


def _section(title: str, content: str) -> str:
    """Render a titled section card."""
    return f"""<div class="email-section" style="background-color:{BRAND['elevated']};border:1px solid {BRAND['border']};border-radius:10px;padding:20px;margin:20px 0;text-align:left;">
  {f'<p style="font-size:11px;font-weight:600;color:{BRAND["muted"]};margin:0 0 8px 0;text-transform:uppercase;letter-spacing:1px;">{title}</p>' if title else ''}
  {content}
</div>"""


def _build_html(body_sections: list[str]) -> str:
    """Assemble a complete HTML email from sections."""
    inner = "\n".join(body_sections)
    return _head() + _logo() + _content_open() + inner + _content_close() + _footer()


# ─── Dispatch helpers ──────────────────────────────────────────────────

async def _dispatch_via_resend(receiver_email: str, subject: str, html_content: str) -> bool:
    import httpx
    api_key = os.getenv("RESEND_API_KEY", "")
    if not api_key:
        return False
    try:
        from app.services.http_client import get_http_client
        client = get_http_client()
        resp = await client.post(
            "https://api.resend.com/emails",
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json={"from": SENDER_FROM, "to": [receiver_email], "subject": subject, "html": html_content},
            timeout=8.0,
        )
        if resp.status_code in {200, 201}:
            logger.info(f"Resend dispatched '{subject}' to {receiver_email}")
            return True
        logger.error(f"Resend error {resp.status_code}: {resp.text[:200]}")
        return False
    except Exception as e:
        logger.error(f"Resend dispatch failed: {e}")
        return False


async def _dispatch_via_smtp(receiver_email: str, subject: str, html_content: str) -> bool:
    if not SENDER_EMAIL or not SENDER_PASSWORD:
        logger.warning("SMTP not configured.")
        return False
    try:
        msg = MIMEMultipart()
        msg["From"] = SENDER_EMAIL
        msg["To"] = receiver_email
        msg["Subject"] = subject
        msg.attach(MIMEText(html_content, "html"))
        import asyncio
        def _send():
            server = smtplib.SMTP(SMTP_SERVER, SMTP_PORT, timeout=8)
            server.starttls()
            server.login(SENDER_EMAIL, SENDER_PASSWORD)
            server.sendmail(SENDER_EMAIL, receiver_email, msg.as_string())
            server.quit()
        await asyncio.to_thread(_send)
        logger.info(f"SMTP dispatched '{subject}' to {receiver_email}")
        return True
    except Exception as e:
        logger.error(f"SMTP dispatch failed: {e}")
        return False


async def _send_email(receiver_email: str, subject: str, html_content: str) -> bool:
    if await _dispatch_via_resend(receiver_email, subject, html_content):
        return True
    return await _dispatch_via_smtp(receiver_email, subject, html_content)


# ─── Email templates ───────────────────────────────────────────────────

async def send_otp_email(receiver_email: str, otp_code: str) -> bool:
    """Verify login — send one-time password."""
    html = _build_html([
        f"""<h2 style="font-family:Georgia,'Times New Roman',serif;color:{BRAND['text']};font-size:20px;margin:0 0 2px 0;font-weight:700;">Verify Your Login</h2>
<p style="font-size:11px;color:{BRAND['muted']};margin:0 0 20px 0;text-transform:uppercase;letter-spacing:1.5px;font-weight:600;">One-Time Password</p>""",
        _divider(),
        f"""<p style="font-size:14px;color:{BRAND['muted']};margin:0;line-height:1.6;">
  Use the code below to complete your login to Strumm.
</p>""",
        _otp_code_block(otp_code),
        f"""<p style="font-size:11px;color:{BRAND['muted']};margin:0;line-height:1.5;">
  This code expires in <strong style="color:{BRAND['text']};">10 minutes</strong>.
</p>""",
    ])
    return await _send_email(receiver_email, f"Your Strumm verification code: {otp_code}", html)


async def send_resend_otp_email(receiver_email: str, otp_code: str) -> bool:
    """Verify signup — send welcome + one-time password."""
    html = _build_html([
        f"""<h2 style="font-family:Georgia,'Times New Roman',serif;color:{BRAND['text']};font-size:20px;margin:0 0 2px 0;font-weight:700;">Welcome to Strumm</h2>
<p style="font-size:11px;color:{BRAND['muted']};margin:0 0 20px 0;text-transform:uppercase;letter-spacing:1.5px;font-weight:600;">Verify Your Email</p>""",
        _divider(),
        f"""<p style="font-size:14px;color:{BRAND['muted']};margin:0 0 4px 0;line-height:1.6;">
  You&rsquo;re almost there. Enter this code to activate your Strumm account.
</p>""",
        _otp_code_block(otp_code),
        f"""<p style="font-size:11px;color:{BRAND['muted']};margin:0;line-height:1.5;">
  This code expires in <strong style="color:{BRAND['text']};">10 minutes</strong>.
</p>""",
        _divider(),
        f"""<p style="font-size:12px;color:{BRAND['muted']};margin:0;line-height:1.6;">
  Once verified, your music passport is ready. Curate playlists, track your listening stats with <strong style="color:{BRAND['text']};">Strumm Replay</strong>, and connect with the community.
</p>""",
    ])
    return await _send_email(receiver_email, f"Welcome to Strumm \u2014 verify your email: {otp_code}", html)


async def send_password_reset_email(receiver_email: str, reset_link: str) -> bool:
    """Reset password — send secure reset link."""
    html = _build_html([
        f"""<h2 style="font-family:Georgia,'Times New Roman',serif;color:{BRAND['text']};font-size:20px;margin:0 0 2px 0;font-weight:700;">Reset Your Password</h2>
<p style="font-size:11px;color:{BRAND['muted']};margin:0 0 20px 0;text-transform:uppercase;letter-spacing:1.5px;font-weight:600;">Security Request</p>""",
        _divider(),
        f"""<p style="font-size:14px;color:{BRAND['muted']};margin:0 0 4px 0;line-height:1.6;">
  A password reset was requested for your Strumm account. Click the button below to choose a new password.
</p>""",
        _cta_button(reset_link, "Reset Password"),
        f"""<p style="font-size:11px;color:{BRAND['muted']};margin:0;line-height:1.5;">
  This link expires in <strong style="color:{BRAND['text']};">1 hour</strong>.
</p>""",
        _section("Didn&rsquo;t request this?", f"""<p style="font-size:12px;color:{BRAND['muted']};margin:0;line-height:1.6;">
  If you did not request a password reset, you can safely ignore this email. Your account remains secure.
</p>"""),
    ])
    return await _send_email(receiver_email, "Reset your Strumm password", html)


async def send_welcome_email(receiver_email: str, username: str) -> bool:
    """Welcome new user after successful signup."""
    frontend_url = os.getenv("FRONTEND_URL") or os.getenv("STRUMM_APP_URL", "https://strumm.me")
    html = _build_html([
        f"""<h2 style="font-family:Georgia,'Times New Roman',serif;color:{BRAND['text']};font-size:20px;margin:0 0 2px 0;font-weight:700;">Welcome to Strumm</h2>
<p style="font-size:11px;color:{BRAND['muted']};margin:0 0 20px 0;text-transform:uppercase;letter-spacing:1.5px;font-weight:600;">Your music passport is ready</p>""",
        _divider(),
        f"""<p style="font-size:14px;color:{BRAND['muted']};margin:0 0 16px 0;line-height:1.6;">
  Hey <strong style="color:{BRAND['text']};">{username}</strong> \u2014 your Strumm space is live.
</p>
<p style="font-size:14px;color:{BRAND['muted']};margin:0 0 4px 0;line-height:1.6;">
  Start adding songs, curate playlists, and discover something new today.
</p>""",
        _cta_button(frontend_url, "Start Listening"),
        _section("Quick tips", """<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;">
  <tr><td style="padding:4px 0;font-size:12px;color:#8E8E93;line-height:1.6;vertical-align:top;width:16px;">\u2022</td><td style="padding:4px 0;font-size:12px;color:#8E8E93;line-height:1.6;">Create playlists from any song or search result</td></tr>
  <tr><td style="padding:4px 0;font-size:12px;color:#8E8E93;line-height:1.6;vertical-align:top;width:16px;">\u2022</td><td style="padding:4px 0;font-size:12px;color:#8E8E93;line-height:1.6;">Track your habits with <strong style="color:#FFFFFF;">Strumm Replay</strong></td></tr>
  <tr><td style="padding:4px 0;font-size:12px;color:#8E8E93;line-height:1.6;vertical-align:top;width:16px;">\u2022</td><td style="padding:4px 0;font-size:12px;color:#8E8E93;line-height:1.6;">Discover music with <strong style="color:#FFFFFF;">Strumm Flow AI</strong></td></tr>
  <tr><td style="padding:4px 0;font-size:12px;color:#8E8E93;line-height:1.6;vertical-align:top;width:16px;">\u2022</td><td style="padding:4px 0;font-size:12px;color:#8E8E93;line-height:1.6;">Connect with friends in <strong style="color:#FFFFFF;">Strumm Circle</strong></td></tr>
</table>"""),
    ])
    return await _send_email(receiver_email, f"Welcome to Strumm, {username}", html)


async def send_password_changed_email(receiver_email: str) -> bool:
    """Notify that password was changed successfully."""
    html = _build_html([
        f"""<h2 style="font-family:Georgia,'Times New Roman',serif;color:{BRAND['text']};font-size:20px;margin:0 0 2px 0;font-weight:700;">Password Changed</h2>
<p style="font-size:11px;color:{BRAND['muted']};margin:0 0 20px 0;text-transform:uppercase;letter-spacing:1.5px;font-weight:600;">Security Alert</p>""",
        _divider(),
        f"""<p style="font-size:14px;color:{BRAND['muted']};margin:0;line-height:1.6;">
  Your Strumm account password was changed successfully.
</p>""",
        _section("Didn&rsquo;t do this?", f"""<p style="font-size:12px;color:{BRAND['muted']};margin:0;line-height:1.6;">
  If you did <strong style="color:{BRAND['text']};">not</strong> authorize this change, please reset your password immediately or contact our support team.
</p>
<div style="margin-top:12px;">
  <a href="{os.getenv('FRONTEND_URL', 'https://strumm.me')}/reset-password" style="font-size:12px;color:{BRAND['primary']};text-decoration:underline;font-weight:600;">Reset your password now \u2192</a>
</div>"""),
    ])
    return await _send_email(receiver_email, "Your Strumm password has been changed", html)


async def send_account_deleted_email(receiver_email: str) -> bool:
    """Confirm that the account was permanently deleted."""
    html = _build_html([
        f"""<h2 style="font-family:Georgia,'Times New Roman',serif;color:{BRAND['text']};font-size:20px;margin:0 0 2px 0;font-weight:700;">Account Deleted</h2>
<p style="font-size:11px;color:{BRAND['muted']};margin:0 0 20px 0;text-transform:uppercase;letter-spacing:1.5px;font-weight:600;">Confirmation</p>""",
        _divider(),
        f"""<p style="font-size:14px;color:{BRAND['muted']};margin:0 0 16px 0;line-height:1.6;">
  Your Strumm account has been permanently deleted. All your data \u2014 playlists, listening history, likes, and profile \u2014 has been removed.
</p>
<p style="font-size:13px;color:{BRAND['muted']};margin:0;line-height:1.6;">
  If this was a mistake, you can create a new account anytime. We&rsquo;d love to have you back.
</p>""",
        _divider(),
        f"""<p style="font-size:13px;color:{BRAND['muted']};margin:0;line-height:1.5;font-style:italic;">
  Thank you for being part of Strumm.
</p>""",
    ])
    return await _send_email(receiver_email, "Your Strumm account has been deleted", html)


async def send_email_changed_email(old_email: str, new_email: str) -> bool:
    """Notify previous email that the email address was changed."""
    frontend_url = os.getenv("FRONTEND_URL") or os.getenv("STRUMM_APP_URL", "https://strumm.me")
    html = _build_html([
        f"""<h2 style="font-family:Georgia,'Times New Roman',serif;color:{BRAND['text']};font-size:20px;margin:0 0 2px 0;font-weight:700;">Email Address Changed</h2>
<p style="font-size:11px;color:{BRAND['muted']};margin:0 0 20px 0;text-transform:uppercase;letter-spacing:1.5px;font-weight:600;">Security Alert</p>""",
        _divider(),
        f"""<p style="font-size:14px;color:{BRAND['muted']};margin:0 0 16px 0;line-height:1.6;">
  The email address associated with your Strumm account has been changed.
</p>""",
        _section("Change details", f"""<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;">
  <tr><td style="font-size:12px;color:{BRAND['muted']};padding:3px 0;line-height:1.5;white-space:nowrap;vertical-align:top;width:1%;"><strong style="color:{BRAND['text']};">Previous:</strong></td><td style="font-size:12px;color:{BRAND['muted']};padding:3px 0 3px 8px;line-height:1.5;word-break:break-all;">{old_email}</td></tr>
  <tr><td style="font-size:12px;color:{BRAND['muted']};padding:3px 0;line-height:1.5;white-space:nowrap;vertical-align:top;width:1%;"><strong style="color:{BRAND['text']};">New:</strong></td><td style="font-size:12px;color:{BRAND['muted']};padding:3px 0 3px 8px;line-height:1.5;word-break:break-all;">{new_email}</td></tr>
</table>"""),
        _section("Didn&rsquo;t do this?", f"""<p style="font-size:12px;color:{BRAND['muted']};margin:0;line-height:1.6;">
  If you did <strong style="color:{BRAND['text']};">not</strong> authorize this change, please contact our support team immediately.
</p>
<div style="margin-top:12px;">
  <a href="{frontend_url}/settings" style="font-size:12px;color:{BRAND['primary']};text-decoration:underline;font-weight:600;">Manage your account \u2192</a>
</div>"""),
    ])
    return await _send_email(old_email, "Your Strumm email address has been changed", html)
