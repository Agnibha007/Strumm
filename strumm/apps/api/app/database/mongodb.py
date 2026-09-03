import os
import logging
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
import dns.resolver
from motor.motor_asyncio import AsyncIOMotorClient
from dotenv import load_dotenv

load_dotenv()

logger = logging.getLogger("strumm-database")

MONGODB_URI = os.getenv("MONGODB_URI", "mongodb://localhost:27017")
DB_NAME = "strumm"
DEFAULT_DNS_SERVERS = ("1.1.1.1", "8.8.8.8")

class Database:
    client: AsyncIOMotorClient = None
    db = None

db_instance = Database()

def get_db():
    return db_instance.db

def configure_dns_resolver():
    nameservers = [
        server.strip()
        for server in os.getenv("DNS_NAMESERVERS", ",".join(DEFAULT_DNS_SERVERS)).split(",")
        if server.strip()
    ]
    if not nameservers:
        return

    resolver = dns.resolver.Resolver(configure=False)
    resolver.nameservers = nameservers
    resolver.timeout = 2
    resolver.lifetime = 5
    dns.resolver.default_resolver = resolver

def connect_db():
    configure_dns_resolver()
    mongo_uri = MONGODB_URI
    db_instance.client = AsyncIOMotorClient(
        mongo_uri,
        # Cloud environments (HF Spaces) have slow/unstable connections to MongoDB Atlas.
        # Use generous timeouts to avoid SSL handshake timeouts and pool thrashing.
        serverSelectionTimeoutMS=15000,   # 15s to select a server
        connectTimeoutMS=10000,            # 10s TCP connect
        socketTimeoutMS=30000,             # 30s socket read/write
        maxPoolSize=50,                    # max concurrent connections
        minPoolSize=2,                     # keep 2 warm connections (reduced from 10)
        maxIdleTimeMS=600000,              # 10 min before idle connection is recycled
        waitQueueTimeoutMS=10000,          # 10s wait for a connection from pool
        heartbeatFrequencyMS=60000,        # 1 min between health checks (default 10s)
        retryWrites=True,
        retryReads=True,
    )
    db_instance.db = db_instance.client[DB_NAME]
    logger.info(f"Connected to MongoDB database: {DB_NAME} (pool: 50/2)")

def close_db():
    if db_instance.client:
        db_instance.client.close()
        logger.info("MongoDB connection closed")

# Collection name constants
USERS = "users"
SONGS = "songs"
PLAYLISTS = "playlists"
LIKED_SONGS = "likedsongs"
PLAYBACK_HISTORIES = "playbackhistories"
PLAYER_STATES = "playerstates"
SHARES = "shares"
PODCAST_SHOWS = "podcastshows"
PODCAST_EPISODES = "podcastepisodes"
PODCAST_PROGRESS = "podcastprogress"
RECENTLY_PLAYED = "recentlyplayeds"

# Social / Realtime collections
CONNECTIONS = "connections"
ACTIVITIES = "activities"
ROOMS = "rooms"
NOTIFICATIONS = "notifications"

# Auth collections
SESSIONS = "sessions"

# Object-storage (B2) media records
MEDIA = "media"
