import os
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
import dns.resolver
from motor.motor_asyncio import AsyncIOMotorClient
from dotenv import load_dotenv

load_dotenv()

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
    db_instance.client = AsyncIOMotorClient(mongo_uri, serverSelectionTimeoutMS=8000)
    db_instance.db = db_instance.client[DB_NAME]
    print(f"Connected to MongoDB database: {DB_NAME}")

def close_db():
    if db_instance.client:
        db_instance.client.close()
        print("MongoDB connection closed")

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
RECENTLY_PLAYED = "recentlyplayeds"
