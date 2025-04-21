import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import * as readline from "readline";
import axios, { type AxiosInstance, type AxiosResponse } from "axios";
import dotenv from "dotenv";
import FormData from "form-data";
import type { GaxiosResponse } from "gaxios";
import { OAuth2Client } from "google-auth-library";
import { google } from "googleapis";

// Carica le variabili d'ambiente dal file .env
dotenv.config();

// Define custom types for Google Photos API
interface MediaItem {
	id?: string;
	baseUrl?: string;
	filename?: string;
	mimeType?: string;
	mediaMetadata?: any;
}

interface Album {
	id?: string;
	title?: string;
	productUrl?: string;
	isWriteable?: boolean;
	mediaItemsCount?: string;
	coverPhotoBaseUrl?: string;
}

// Define Photos Library API interface
interface PhotosLibraryClient {
	albums: {
		list: () => Promise<GaxiosResponse<{ albums?: Album[] }>>;
	};
	mediaItems: {
		search: (params: { requestBody: any }) => Promise<
			GaxiosResponse<{ mediaItems?: MediaItem[]; nextPageToken?: string }>
		>;
	};
}

// Definizione delle interfacce
interface GooglePhotosConfig {
	clientId: string;
	clientSecret: string;
	redirectUri: string;
	scopes: string[];
	tokenPath: string;
	albumIds: string[];
}

interface ImmichConfig {
	apiKey: string;
	serverUrl: string;
	albumNames: {
		[key: string]: string;
	};
}

interface Config {
	googlePhotos: GooglePhotosConfig;
	immich: ImmichConfig;
	tempDir: string;
	syncedPhotosFile: string;
}

interface TokenInfo {
	access_token: string;
	refresh_token: string;
	scope: string;
	token_type: string;
	expiry_date: number;
}

interface ImmichAlbum {
	id: string;
	albumName: string;
}

interface ImmichAsset {
	id: string;
	[key: string]: any;
}

interface SyncedPhotos {
	[albumId: string]: string[];
}

// Parse album IDs e nomi album da variabili d'ambiente
function parseAlbumConfig(): {
	albumIds: string[];
	albumNamesMap: { [key: string]: string };
} {
	const albumIdsEnv = process.env.GOOGLE_PHOTOS_ALBUM_IDS || "";
	const albumNamesEnv = process.env.IMMICH_ALBUM_NAMES || "";

	const albumIds = albumIdsEnv
		.split(",")
		.map((id) => id.trim())
		.filter((id) => id !== "");
	const albumNamesMap: { [key: string]: string } = {};

	// Formato atteso: "ID_ALBUM_1:Nome Album 1,ID_ALBUM_2:Nome Album 2"
	const albumPairs = albumNamesEnv
		.split(",")
		.map((pair) => pair.trim())
		.filter((pair) => pair !== "");
	for (const pair of albumPairs) {
		const [id, name] = pair.split(":").map((item) => item.trim());
		if (id && name) {
			albumNamesMap[id] = name;
		}
	}

	return { albumIds, albumNamesMap };
}

// Configura le variabili d'ambiente
const { albumIds, albumNamesMap } = parseAlbumConfig();

// Configurazione
const CONFIG: Config = {
	// Configurazione Google Photos
	googlePhotos: {
		clientId: process.env.GOOGLE_CLIENT_ID || "",
		clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
		redirectUri:
			process.env.GOOGLE_REDIRECT_URI || "http://localhost:3000/oauth2callback",
		scopes: [
			"https://www.googleapis.com/auth/photoslibrary.readonly",
			"https://www.googleapis.com/auth/photoslibrary.sharing", // For shared albums
		],
		tokenPath: path.join(
			__dirname,
			"..",
			process.env.GOOGLE_TOKEN_PATH || "google_token.json",
		),
		albumIds: albumIds,
	},
	// Configurazione Immich
	immich: {
		apiKey: process.env.IMMICH_API_KEY || "",
		serverUrl: process.env.IMMICH_SERVER_URL || "http://localhost:3001/api",
		albumNames: albumNamesMap,
	},
	// Cartella temporanea per il download delle foto
	tempDir: path.join(__dirname, "..", process.env.TEMP_DIR || "temp"),
	// File per tenere traccia delle foto già sincronizzate
	syncedPhotosFile: path.join(
		__dirname,
		"..",
		process.env.SYNCED_PHOTOS_FILE || "synced_photos.json",
	),
};

// Valida la configurazione
function validateConfig(): void {
	const requiredEnvVars = [
		{ name: "GOOGLE_CLIENT_ID", value: CONFIG.googlePhotos.clientId },
		{ name: "GOOGLE_CLIENT_SECRET", value: CONFIG.googlePhotos.clientSecret },
		{ name: "IMMICH_API_KEY", value: CONFIG.immich.apiKey },
		{
			name: "GOOGLE_PHOTOS_ALBUM_IDS",
			value: CONFIG.googlePhotos.albumIds.length > 0 ? "present" : "",
		},
		{
			name: "IMMICH_ALBUM_NAMES",
			value: Object.keys(CONFIG.immich.albumNames).length > 0 ? "present" : "",
		},
	];

	const missingVars = requiredEnvVars.filter((v) => !v.value);

	if (missingVars.length > 0) {
		console.error(
			"Errore: Mancano le seguenti variabili d'ambiente richieste:",
		);
		missingVars.forEach((v) => console.error(`- ${v.name}`));
		console.error(
			"\nAssicurati di aver configurato correttamente il file .env",
		);
		process.exit(1);
	}

	// Controlla che tutti gli album IDs abbiano un nome corrispondente
	const missingNames = CONFIG.googlePhotos.albumIds.filter(
		(id) => !CONFIG.immich.albumNames[id],
	);
	if (missingNames.length > 0) {
		console.warn(
			"Attenzione: I seguenti album ID non hanno nomi corrispondenti configurati:",
		);
		missingNames.forEach((id) => console.warn(`- ${id}`));
		console.warn("Questi album verranno saltati durante la sincronizzazione.");
	}
}

// Assicurati che la cartella temporanea esista
if (!fs.existsSync(CONFIG.tempDir)) {
	fs.mkdirSync(CONFIG.tempDir, { recursive: true });
}

// Inizializza il client OAuth2
const oAuth2Client = new OAuth2Client(
	CONFIG.googlePhotos.clientId,
	CONFIG.googlePhotos.clientSecret,
	CONFIG.googlePhotos.redirectUri,
);

// Test connection to Immich server
async function testImmichConnection(
	serverUrl: string,
	apiKey: string,
): Promise<boolean> {
	try {
		// Test with a simple GET request to the server root
		const response = await axios.get(`${serverUrl}/system-config`, {
			headers: {
				"x-api-key": apiKey,
			},
		});

		console.log("Successfully connected to Immich server");
		console.log("Server response:", response.status);
		console.log(
			"Server version:",
			response.headers["x-immich-version"] || "Unknown",
		);

		// Try to get the server info
		try {
			const infoResponse = await axios.get(`${serverUrl}/system-config`, {
				headers: {
					"x-api-key": apiKey,
				},
			});
			console.log("Server info:", infoResponse.data);
		} catch (infoError) {
			console.log("Could not get server info, but basic connection works");
		}
		return true;
	} catch (error: any) {
		console.error("Failed to connect to Immich server");
		console.error("Error:", error.message);

		if (error.code === "ECONNREFUSED") {
			console.error("\nConnection refused. Please check:");
			console.error("1. Is the Immich server running?");
			console.error("2. Is the hostname/IP correct?");
			console.error("3. Is the port correct?");
			console.error("4. Are there any firewalls blocking the connection?");
		}

		if (error.response) {
			console.error("Response status:", error.response.status);
			console.error("Response data:", error.response.data);
		}
		return false;
	}
}

// Carica le foto già sincronizzate
function loadSyncedPhotos(): SyncedPhotos {
	try {
		if (fs.existsSync(CONFIG.syncedPhotosFile)) {
			return JSON.parse(fs.readFileSync(CONFIG.syncedPhotosFile, "utf8"));
		}
	} catch (error) {
		console.error("Errore nel caricamento delle foto sincronizzate:", error);
	}
	return {};
}

// Salva le foto già sincronizzate
function saveSyncedPhotos(syncedPhotos: SyncedPhotos): void {
	fs.writeFileSync(
		CONFIG.syncedPhotosFile,
		JSON.stringify(syncedPhotos, null, 2),
	);
}

// Ottieni un token di accesso Google
async function getGoogleAccessToken(): Promise<OAuth2Client> {
	try {
		// Check if we already have a saved token
		if (fs.existsSync(CONFIG.googlePhotos.tokenPath)) {
			const token: TokenInfo = JSON.parse(
				fs.readFileSync(CONFIG.googlePhotos.tokenPath, "utf8"),
			);
			oAuth2Client.setCredentials(token);

			// If token is expired or will expire soon (within 5 minutes)
			if (token.expiry_date && token.expiry_date < Date.now() + 5 * 60 * 1000) {
				console.log("Token expired or will expire soon, refreshing...");
				if (token["refresh_token"]) {
					try {
						// Refresh the token
						const refreshedTokens: any = await oAuth2Client["refreshToken"](
							token["refresh_token"],
						);
						const newToken = {
							access_token:
								refreshedTokens.tokens.access_token || token.access_token,
							refresh_token:
								refreshedTokens.tokens.refresh_token || token.refresh_token,
							expiry_date:
								refreshedTokens.tokens.expiry_date || token.expiry_date,
							scope: refreshedTokens.tokens.scope || token.scope,
							token_type: refreshedTokens.tokens.token_type || token.token_type,
						};

						// Save the refreshed token
						fs.writeFileSync(
							CONFIG.googlePhotos.tokenPath,
							JSON.stringify(newToken, null, 2),
						);

						oAuth2Client.setCredentials(newToken);
						console.log("Token refreshed successfully");
					} catch (refreshError) {
						console.error("Error refreshing token:", refreshError);
						console.log("Attempting to get a new token...");
						return await getNewToken();
					}
				} else {
					console.warn(
						"No refresh token available, requesting new authorization",
					);
					return await getNewToken();
				}
			}
			return oAuth2Client;
		} else {
			// If no token exists, get a new one
			return await getNewToken();
		}
	} catch (error) {
		console.error("Error getting access token:", error);
		throw error;
	}
}

async function getNewTokenWithServer(): Promise<OAuth2Client> {
	return new Promise((resolve, reject) => {
		// Create a temporary local server to handle the OAuth callback
		const server = http.createServer(async (req, res) => {
			try {
				// Parse the URL
				const url = new URL(req.url || "", "http://localhost");
				const code = url.searchParams.get("code");

				if (code) {
					// Close the response with a success message
					res.writeHead(200, { "Content-Type": "text/html" });
					res.end(
						"<h1>Authentication successful!</h1><p>You can close this window now.</p>",
					);

					// Close the server
					server.close();

					// Exchange the code for tokens
					const { tokens } = await oAuth2Client.getToken(code);
					oAuth2Client.setCredentials(tokens);

					// Save the token
					fs.writeFileSync(
						CONFIG.googlePhotos.tokenPath,
						JSON.stringify(tokens, null, 2),
					);

					console.log("Token obtained and saved successfully");
					resolve(oAuth2Client);
				} else {
					res.writeHead(400, { "Content-Type": "text/html" });
					res.end(
						"<h1>Authentication failed</h1><p>No authorization code received.</p>",
					);
				}
			} catch (error) {
				console.error("Error in OAuth callback:", error);
				res.writeHead(500, { "Content-Type": "text/html" });
				res.end(
					"<h1>Authentication error</h1><p>An error occurred during authentication.</p>",
				);
				reject(error);
			}
		});

		// Get a random available port or use a specific one
		const port = 3000; // You can also use 0 to get a random available port
		server.listen(port, () => {
			// Generate the OAuth URL with the correct redirect URI
			const redirectUri = `http://localhost:${port}`;
			const authUrl: any = oAuth2Client.generateAuthUrl({
				access_type: "offline",
				prompt: "consent",
				scope: CONFIG.googlePhotos.scopes,
				redirect_uri: redirectUri,
			});

			// Update the client's redirect URI
			oAuth2Client["redirectUri"] = redirectUri;

			console.log("\n-----------------------------------------------------");
			console.log("Authorize this app by visiting this URL:", authUrl);
			console.log("-----------------------------------------------------\n");
			console.log("The browser should automatically redirect back to the app.");

			// Open the URL in the default browser if possible
			try {
				const open = require("open");
				open(authUrl);
			} catch (error) {
				console.log(
					"Could not automatically open browser. Please manually visit the URL.",
				);
			}
		});
	});
}
// Ottieni un nuovo token dopo l'autorizzazione dell'utente
async function getNewToken(): Promise<OAuth2Client> {
	const authUrl = oAuth2Client.generateAuthUrl({
		access_type: "offline",
		prompt: "consent", // Force to get a refresh token
		scope: CONFIG.googlePhotos.scopes,
	});

	console.log("\n-----------------------------------------------------");
	console.log("Autorizza questa app visitando questo URL:", authUrl);
	console.log("-----------------------------------------------------\n");

	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	return new Promise((resolve, reject) => {
		rl.question(
			"Inserisci il codice ottenuto dopo l'autorizzazione: ",
			async (code) => {
				rl.close();
				try {
					console.log("Ottenimento del token con il codice fornito...");
					const { tokens } = await oAuth2Client.getToken(code.trim());

					if (!tokens.refresh_token) {
						console.warn(
							"Warning: No refresh token received! You might need to revoke access and try again.",
						);
					}

					oAuth2Client.setCredentials(tokens);
					fs.writeFileSync(
						CONFIG.googlePhotos.tokenPath,
						JSON.stringify(tokens, null, 2),
					);
					console.log("Token salvato in", CONFIG.googlePhotos.tokenPath);
					resolve(oAuth2Client);
				} catch (error) {
					console.error(
						"Errore durante il recupero del token di accesso:",
						error,
					);
					reject(error);
				}
			},
		);
	});
}

// Get all user's albums from Google Photos
async function listAllGoogleAlbums(authClient: OAuth2Client): Promise<Album[]> {
	try {
		let allAlbums: Album[] = [];
		let nextPageToken: string | null | undefined = null;

		do {
			const response = await axios.get(
				"https://photoslibrary.googleapis.com/v1/albums",
				{
					params: {
						pageSize: 50,
						pageToken: nextPageToken || undefined,
					},
					headers: {
						Authorization: `Bearer ${(await authClient.getAccessToken()).token}`,
					},
				},
			);

			if (response.data.albums) {
				allAlbums = allAlbums.concat(response.data.albums);
			}

			nextPageToken = response.data.nextPageToken;
		} while (nextPageToken);

		return allAlbums;
	} catch (error) {
		console.error("Error retrieving all albums:", error);
		throw error;
	}
}

// Get shared albums from Google Photos
async function listSharedGoogleAlbums(
	authClient: OAuth2Client,
): Promise<Album[]> {
	try {
		let allSharedAlbums: Album[] = [];
		let nextPageToken: string | null | undefined = null;

		do {
			const response = await axios.get(
				"https://photoslibrary.googleapis.com/v1/sharedAlbums",
				{
					params: {
						pageSize: 50,
						pageToken: nextPageToken || undefined,
					},
					headers: {
						Authorization: `Bearer ${(await authClient.getAccessToken()).token}`,
					},
				},
			);

			if (response.data.sharedAlbums) {
				allSharedAlbums = allSharedAlbums.concat(response.data.sharedAlbums);
			}

			nextPageToken = response.data.nextPageToken;
		} while (nextPageToken);

		return allSharedAlbums;
	} catch (error) {
		console.error("Error retrieving shared albums:", error);
		throw error;
	}
}

// Display all albums (both user's and shared)
async function displayAllAlbums(authClient: OAuth2Client): Promise<void> {
	console.log("Fetching all available Google Photos albums...");
	const albums = await listAllGoogleAlbums(authClient);

	console.log("\n----- Your Google Photos Albums -----");
	for (const album of albums) {
		console.log(`Title: ${album.title}`);
		console.log(`ID: ${album.id}`);
		console.log(`Media items count: ${album.mediaItemsCount || "Unknown"}`);
		console.log("----------------------------------------\n");
	}

	console.log("\nFetching all shared Google Photos albums...");
	const sharedAlbums = await listSharedGoogleAlbums(authClient);

	console.log("\n----- Shared Google Photos Albums -----");
	for (const album of sharedAlbums) {
		console.log(`Title: ${album.title}`);
		console.log(`ID: ${album.id}`);
		console.log(`Shared album URL: ${album.productUrl}`);
		console.log(`Media items count: ${album.mediaItemsCount || "Unknown"}`);
		console.log("----------------------------------------\n");
	}

	console.log(
		"Use these album IDs in your GOOGLE_PHOTOS_ALBUM_IDS environment variable",
	);
	console.log("Example format: GOOGLE_PHOTOS_ALBUM_IDS=id1,id2,id3");
	console.log(
		"And map them to album names with: IMMICH_ALBUM_NAMES=id1:Name1,id2:Name2,id3:Name3",
	);
}

// Verify if an album exists before trying to get photos
async function verifyAlbumExists(
	authClient: OAuth2Client,
	albumId: string,
): Promise<boolean> {
	try {
		const token = await authClient.getAccessToken();
		const response = await axios.get(
			`https://photoslibrary.googleapis.com/v1/albums/${albumId}`,
			{
				headers: {
					Authorization: `Bearer ${token.token}`,
					"Content-Type": "application/json",
				},
			},
		);

		return response.status === 200;
	} catch (error) {
		console.error(`Album verification failed for ID ${albumId}:`);
		if (error.response && error.response.data && error.response.data.error) {
			console.error(
				"Error details:",
				JSON.stringify(error.response.data.error, null, 2),
			);
		}

		// Check if it might be a shared album
		try {
			const sharedAlbums = await listSharedGoogleAlbums(authClient);
			const foundAlbum = sharedAlbums.find((album) => album.id === albumId);
			if (foundAlbum) {
				console.log(
					`Found album ${albumId} as a shared album: "${foundAlbum.title}"`,
				);
				return true;
			}
		} catch (sharedError: any) {
			console.error("Error checking shared albums:", sharedError.message);
		}

		return false;
	}
}

// Ottieni le foto da un album Google Photos
async function getPhotosFromAlbum(
	authClient: OAuth2Client,
	albumId: string,
): Promise<MediaItem[]> {
	try {
		const auth = authClient;
		const endpoint = "https://photoslibrary.googleapis.com";
		const version = "v1";

		let photos: MediaItem[] = [];
		let nextPageToken: string | null | undefined = null;

		// First, let's check if this is a shared album
		let isSharedAlbum = false;

		try {
			// Try to access it as a shared album first
			const sharedAlbums = await listSharedGoogleAlbums(authClient);
			isSharedAlbum = sharedAlbums.some((album) => album.id === albumId);

			if (isSharedAlbum) {
				console.log(
					`Album ${albumId} is a shared album. Using appropriate access method.`,
				);
			}
		} catch (error) {
			console.warn(
				`Could not determine if album ${albumId} is shared. Proceeding with standard method.`,
			);
		}

		do {
			try {
				const response: AxiosResponse<{
					mediaItems?: MediaItem[];
					nextPageToken?: string;
				}> = await axios.post(
					`${endpoint}/${version}/mediaItems:search`,
					{
						albumId: albumId,
						pageSize: 100,
						pageToken: nextPageToken || undefined,
					},
					{
						headers: {
							Authorization: `Bearer ${(await auth.getAccessToken()).token}`,
							"Content-Type": "application/json",
						},
					},
				);

				if (response.data.mediaItems) {
					photos = photos.concat(response.data.mediaItems);
				}

				nextPageToken = response.data.nextPageToken;
			} catch (error) {
				console.error(`Error retrieving photos from album ${albumId}:`);
				if (
					error.response &&
					error.response.data &&
					error.response.data.error
				) {
					console.error(
						"Error details:",
						JSON.stringify(error.response.data.error, null, 2),
					);
				}

				// Special handling for shared albums
				if (isSharedAlbum) {
					console.error(
						"This is a shared album. Make sure you have the correct access permissions.",
					);
				}

				throw error;
			}
		} while (nextPageToken);

		return photos;
	} catch (error) {
		console.error(
			`Errore nel recupero delle foto dall'album ${albumId}:`,
			error,
		);
		throw error;
	}
}

// Scarica una foto da Google Photos
async function downloadPhoto(url: string, filePath: string): Promise<void> {
	try {
		const response = await axios({
			url,
			method: "GET",
			responseType: "stream",
		});

		const writer = fs.createWriteStream(filePath);

		return new Promise<void>((resolve, reject) => {
			response.data.pipe(writer);
			writer.on("finish", resolve);
			writer.on("error", reject);
		});
	} catch (error) {
		console.error(`Errore nel download della foto da ${url}:`, error);
		throw error;
	}
}

// Interagisci con l'API di Immich
class ImmichAPI {
	private apiKey: string;
	private serverUrl: string;
	private axios: AxiosInstance;

	constructor(apiKey: string, serverUrl: string) {
		this.apiKey = apiKey;
		this.serverUrl = serverUrl;
		this.axios = axios.create({
			baseURL: serverUrl,
			headers: {
				"x-api-key": apiKey,
			},
		});
	}

	async getAlbums(): Promise<ImmichAlbum[]> {
		try {
			try {
				// Try newer endpoint first
				const response = await this.axios.get("/albums");
				return response.data;
			} catch (error: any) {
				if (error.response && error.response.status === 404) {
					console.log(
						"Newer album endpoint not found, trying legacy endpoint...",
					);
					// Try legacy endpoint
					const response = await this.axios.get("/album");
					return response.data;
				}
				throw error;
			}
		} catch (error) {
			console.error("Errore nel recupero degli album da Immich:", error);
			// Return empty array to prevent script from crashing
			return [];
		}
	}

	async createAlbum(name: string): Promise<ImmichAlbum> {
		try {
			try {
				// Try newer endpoint first
				const response = await this.axios.post("/albums", {
					albumName: name,
				});
				return response.data;
			} catch (error: any) {
				if (error.response && error.response.status === 404) {
					console.log(
						"Newer album creation endpoint not found, trying legacy endpoint...",
					);
					// Try legacy endpoint
					const response = await this.axios.post("/album", {
						albumName: name,
					});
					return response.data;
				}
				throw error;
			}
		} catch (error) {
			console.error(
				`Errore nella creazione dell'album "${name}" in Immich:`,
				error,
			);
			throw error;
		}
	}

	async uploadPhoto(
		filePath: string,
		albumId: string | null = null,
	): Promise<ImmichAsset> {
		try {
			// Step 1: Upload the asset first
			const form = new FormData();
			const filename = path.basename(filePath);
			const deviceAssetId = `web-${filename}-${Date.now()}`;
			const fileCreatedAt = new Date().toISOString();
			const fileModifiedAt = fileCreatedAt;

			// Add the required form fields
			form.append("deviceAssetId", deviceAssetId);
			form.append("deviceId", "WEB");
			form.append("fileCreatedAt", fileCreatedAt);
			form.append("fileModifiedAt", fileModifiedAt);
			form.append("isFavorite", "false");
			form.append("duration", "0:00:00.000000");
			form.append("assetData", fs.createReadStream(filePath));

			// Upload the asset
			const response = await this.axios.post("/assets", form, {
				headers: {
					...form.getHeaders(),
				},
			});

			const assetId = response.data.id;

			// Step 2: If an album ID is provided, add the asset to the album
			if (albumId) {
				await this.addAssetToAlbum(assetId, albumId);
			}

			return response.data;
		} catch (error: any) {
			console.error(
				`Errore nel caricamento della foto ${filePath} su Immich:`,
				error,
			);

			// Log more detailed error information
			if (error.response) {
				console.error("Response status:", error.response.status);
				console.error("Response data:", error.response.data);
				console.error(
					"Headers:",
					JSON.stringify(error.response.headers, null, 2),
				);
			}

			throw error;
		}
	}

	async addAssetToAlbum(assetId: string, albumId: string): Promise<void> {
		try {
			// Updated to match the API call in your curl example
			await this.axios.put(`/albums/${albumId}/assets`, {
				ids: [assetId], // Note: using 'ids' instead of 'assetIds' as per your curl example
			});
		} catch (error: any) {
			if (error.response && error.response.status === 404) {
				console.log(
					"Newer album assets endpoint not found, trying legacy endpoint...",
				);
				// Try legacy endpoint with the old parameter name
				await this.axios.put(`/album/${albumId}/assets`, {
					assetIds: [assetId],
				});
			} else {
				console.error(
					`Errore nell'aggiunta dell'asset ${assetId} all'album ${albumId}:`,
					error,
				);
				throw error;
			}
		}
	}
}

// Funzione principale
async function syncGooglePhotosToImmich(): Promise<void> {
	console.log("Avvio sincronizzazione da Google Photos a Immich...");

	// Check if the --list-albums argument is provided
	if (process.argv.includes("--list-albums")) {
		const authClient = await getGoogleAccessToken();
		await displayAllAlbums(authClient);
		return;
	}

	// Valida la configurazione prima di iniziare
	validateConfig();

	// Test Immich connection
	console.log(
		`Testing connection to Immich server at ${CONFIG.immich.serverUrl}...`,
	);
	const connectionSuccessful = await testImmichConnection(
		CONFIG.immich.serverUrl,
		CONFIG.immich.apiKey,
	);

	if (!connectionSuccessful) {
		const rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
		});

		const continueSync = await new Promise<boolean>((resolve) => {
			rl.question(
				"Connection to Immich server failed. Do you want to continue anyway? (y/n): ",
				(answer) => {
					rl.close();
					resolve(
						answer.toLowerCase() === "y" || answer.toLowerCase() === "yes",
					);
				},
			);
		});

		if (!continueSync) {
			console.log("Synchronization aborted by user");
			return;
		}
	}

	try {
		// Inizializza il client di autenticazione Google
		const authClient = await getGoogleAccessToken();

		// Inizializza l'API di Immich
		const immichApi = new ImmichAPI(
			CONFIG.immich.apiKey,
			CONFIG.immich.serverUrl,
		);

		// Carica le foto già sincronizzate
		const syncedPhotos = loadSyncedPhotos();

		// Ottieni gli album di Immich
		const immichAlbums = await immichApi.getAlbums();
		const immichAlbumsMap: { [key: string]: string } = {};

		// Mappa gli album di Immich per nome
		for (const album of immichAlbums) {
			immichAlbumsMap[album.albumName] = album.id;
		}

		// Output album IDs from config for debugging
		console.log(CONFIG.googlePhotos.albumIds);

		// Processa ogni album configurato
		for (const albumId of CONFIG.googlePhotos.albumIds) {
			const immichAlbumName = CONFIG.immich.albumNames[albumId];

			if (!immichAlbumName) {
				console.warn(
					`Nessun nome di album Immich configurato per l'album Google Photos ${albumId}, saltando...`,
				);
				continue;
			}

			console.log(
				`Sincronizzazione dell'album "${immichAlbumName}" (ID Google Photos: ${albumId})...`,
			);

			// Verify the album exists first
			const albumExists = await verifyAlbumExists(authClient, albumId);
			if (!albumExists) {
				console.error(
					`Album con ID ${albumId} non trovato o non accessibile. Saltando...`,
				);
				continue;
			}

			// Crea l'album in Immich se non esiste
			let immichAlbumId = immichAlbumsMap[immichAlbumName];
			if (!immichAlbumId) {
				console.log(
					`Album "${immichAlbumName}" non trovato in Immich, creazione in corso...`,
				);
				const newAlbum = await immichApi.createAlbum(immichAlbumName);
				immichAlbumId = newAlbum.id;
				immichAlbumsMap[immichAlbumName] = immichAlbumId;
			}

			// Inizializza l'array delle foto sincronizzate per questo album se non esiste
			if (!syncedPhotos[albumId]) {
				syncedPhotos[albumId] = [];
			}

			// Ottieni le foto dall'album di Google Photos
			const photos = await getPhotosFromAlbum(authClient, albumId);
			console.log(`Trovate ${photos.length} foto nell'album di Google Photos.`);

			// Filtra le foto non ancora sincronizzate
			const photosToSync = photos.filter(
				(photo) => !syncedPhotos[albumId].includes(photo.id || ""),
			);
			console.log(`${photosToSync.length} nuove foto da sincronizzare.`);

			// Sincronizza ogni foto
			for (const [index, photo] of photosToSync.entries()) {
				if (!photo.id || !photo.baseUrl || !photo.filename) {
					console.warn(`Foto con dati mancanti, saltando...`, photo);
					continue;
				}

				console.log(
					`Sincronizzazione della foto ${index + 1}/${photosToSync.length}: ${photo.filename}`,
				);

				// Scarica la foto
				const downloadUrl = `${photo.baseUrl}=d`; // =d significa scaricare l'originale
				const tempFilePath = path.join(CONFIG.tempDir, photo.filename);

				await downloadPhoto(downloadUrl, tempFilePath);
				console.log(`Foto scaricata in ${tempFilePath}`);

				// Carica la foto su Immich
				await immichApi.uploadPhoto(tempFilePath, immichAlbumId);
				console.log(`Foto caricata su Immich nell'album "${immichAlbumName}"`);

				// Elimina il file temporaneo
				fs.unlinkSync(tempFilePath);

				// Aggiungi l'ID della foto all'elenco delle foto sincronizzate
				syncedPhotos[albumId].push(photo.id);

				// Salva lo stato di sincronizzazione dopo ogni foto
				saveSyncedPhotos(syncedPhotos);
			}

			console.log(
				`Sincronizzazione dell'album "${immichAlbumName}" completata.`,
			);
		}

		console.log(
			"Sincronizzazione da Google Photos a Immich completata con successo!",
		);
	} catch (error) {
		console.error("Errore durante la sincronizzazione:", error);
	}
}

// Esegui la sincronizzazione
syncGooglePhotosToImmich();

// Esporta le funzioni per l'uso in altri script
export { syncGooglePhotosToImmich, CONFIG, ImmichAPI };
