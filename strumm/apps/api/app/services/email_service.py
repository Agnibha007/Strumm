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
SENDER_PASSWORD = os.getenv("SENDER_PASSWORD", "") # Google App Password

async def send_otp_email(receiver_email: str, otp_code: str) -> bool:
    # If credentials are not set up, skip and log to console (development fallback)
    if not SENDER_EMAIL or not SENDER_PASSWORD:
        logger.warning("SMTP credentials not fully configured. Skipping real email dispatch.")
        return False
        
    try:
        # Create message envelope
        msg = MIMEMultipart()
        msg["From"] = SENDER_EMAIL
        msg["To"] = receiver_email
        msg["Subject"] = f"Your Strumm verification code: {otp_code}"
        
        # HTML body with editorial style matching the Obsidian theme
        html_body = f"""
        <html>
            <body style="background-color: #080808; color: #FFFFFF; font-family: sans-serif; padding: 24px; text-align: center;">
                <div style="max-width: 450px; margin: 0 auto; background-color: #121212; border: 1px solid #222222; border-radius: 12px; padding: 32px; box-shadow: 0 4px 12px rgba(0,0,0,0.5);">
                    <h1 style="font-family: serif; color: #FF5500; font-size: 32px; margin-bottom: 8px;">Strumm</h1>
                    <p style="text-transform: uppercase; font-size: 10px; tracking: 2px; color: #C6A15B; font-weight: bold; margin-top: 0;">Where your music lives.</p>
                    <hr style="border-color: #222222; margin: 24px 0;" />
                    <p style="font-size: 14px; color: #8E8E93;">Verify your entry to Strumm. Use the one-time verification password below:</p>
                    <div style="background-color: #1A1A1A; border: 1px solid #333; font-family: monospace; font-size: 36px; font-weight: bold; color: #FFFFFF; padding: 16px; border-radius: 8px; margin: 24px 0; letter-spacing: 6px; text-align: center;">
                        {otp_code}
                    </div>
                    <p style="font-size: 11px; color: #8E8E93;">This verification session expires in 10 minutes. If you did not prompt this request, you can safely ignore this mail.</p>
                </div>
            </body>
        </html>
        """
        msg.attach(MIMEText(html_body, "html"))
        
        # Dispatch SMTP call
        server = smtplib.SMTP(SMTP_SERVER, SMTP_PORT)
        server.starttls() # Secure STARTTLS handshake
        server.login(SENDER_EMAIL, SENDER_PASSWORD)
        server.sendmail(SENDER_EMAIL, receiver_email, msg.as_string())
        server.quit()
        
        logger.info(f"Successfully dispatched verification code mail to {receiver_email}")
        return True
    except Exception as e:
        logger.error(f"Failed to dispatch verification email to {receiver_email}: {str(e)}")
        return False
