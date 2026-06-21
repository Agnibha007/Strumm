import json
import os
import subprocess
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

def resolve_mongodb_srv_with_windows_dns(uri: str) -> str:
    if os.name != "nt" or not uri.startswith("mongodb+srv://"):
        return uri

    parsed = urlsplit(uri)
    if not parsed.hostname:
        return uri

    srv_name = f"_mongodb._tcp.{parsed.hostname}"
    command = (
        f"Resolve-DnsName -Type SRV {srv_name} | "
        "Select-Object NameTarget,Port | ConvertTo-Json -Compress"
    )

    try:
        result = subprocess.run(
            ["powershell", "-NoProfile", "-Command", command],
            capture_output=True,
            text=True,
            timeout=8,
            check=True,
        )
        records = json.loads(result.stdout)
    except Exception:
        return uri

    if isinstance(records, dict):
        records = [records]

    hosts = []
    for record in records:
        target = str(record.get("NameTarget", "")).strip().rstrip(".")
        port = int(record.get("Port", 27017) or 27017)
        if target:
            hosts.append(f"{target}:{port}")

    if not hosts:
        return uri

    netloc = ",".join(hosts)
    if parsed.username:
        credentials = parsed.username
        if parsed.password:
            credentials = f"{credentials}:{parsed.password}"
        netloc = f"{credentials}@{netloc}"

    query_params = dict(parse_qsl(parsed.query, keep_blank_values=True))
    query_params.update(resolve_mongodb_txt_options_with_windows_dns(parsed.hostname))
    query_params.setdefault("tls", "true")
    query = urlencode(query_params)

    return urlunsplit(("mongodb", netloc, parsed.path, query, parsed.fragment))

def resolve_mongodb_txt_options_with_windows_dns(hostname: str) -> dict[str, str]:
    command = (
        f"Resolve-DnsName -Type TXT {hostname} | "
        "Select-Object -ExpandProperty Strings | ConvertTo-Json -Compress"
    )

    try:
        result = subprocess.run(
            ["powershell", "-NoProfile", "-Command", command],
            capture_output=True,
            text=True,
            timeout=8,
            check=True,
        )
        strings = json.loads(result.stdout)
    except Exception:
        return {}

    if isinstance(strings, str):
        strings = [strings]

    options = {}
    for value in strings:
        options.update(dict(parse_qsl(str(value), keep_blank_values=True)))
    return options

def connect_db():
    configure_dns_resolver()
    mongo_uri = resolve_mongodb_srv_with_windows_dns(MONGODB_URI)
    db_instance.client = AsyncIOMotorClient(mongo_uri, serverSelectionTimeoutMS=8000)
    db_instance.db = db_instance.client[DB_NAME]
    print(f"Connected to MongoDB database: {DB_NAME}")

def close_db():
    if db_instance.client:
        db_instance.client.close()
        print("MongoDB connection closed")

# Helper helpers for collection names
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
