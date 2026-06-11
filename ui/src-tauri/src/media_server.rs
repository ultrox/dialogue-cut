//! Minimal loopback HTTP server for streaming local video into the webview.
//! Tauri's asset protocol cannot reliably serve multi-gigabyte videos on
//! macOS (tauri-apps/tauri#7355), so the player streams from
//! http://127.0.0.1 instead, which WKWebView handles natively with range
//! requests. Only files explicitly registered via serve_media are reachable.

use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read, Seek, SeekFrom, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, OnceLock,
    },
    thread,
};

struct MediaServer {
    port: u16,
    files: Mutex<HashMap<String, PathBuf>>,
    next_token: AtomicU64,
}

static SERVER: OnceLock<Result<MediaServer, String>> = OnceLock::new();

fn server() -> Result<&'static MediaServer, String> {
    SERVER
        .get_or_init(|| {
            let listener = TcpListener::bind("127.0.0.1:0")
                .map_err(|error| format!("Could not start the media server: {error}"))?;
            let port = listener
                .local_addr()
                .map_err(|error| format!("Could not start the media server: {error}"))?
                .port();
            thread::spawn(move || {
                for stream in listener.incoming().flatten() {
                    thread::spawn(move || {
                        let _ = handle_connection(stream);
                    });
                }
            });
            Ok(MediaServer {
                port,
                files: Mutex::new(HashMap::new()),
                next_token: AtomicU64::new(1),
            })
        })
        .as_ref()
        .map_err(Clone::clone)
}

/// Registers a file and returns the localhost URL it streams from.
pub(crate) fn serve_media(path: &Path) -> Result<String, String> {
    if !path.is_file() {
        return Err("Choose an existing video file first.".into());
    }
    let server = server()?;
    let token = format!("media-{}", server.next_token.fetch_add(1, Ordering::SeqCst));
    server
        .files
        .lock()
        .map_err(|_| "Media server lock failed.")?
        .insert(token.clone(), path.to_path_buf());
    Ok(format!("http://127.0.0.1:{}/{token}", server.port))
}

fn content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("mp4") | Some("m4v") => "video/mp4",
        Some("mov") => "video/quicktime",
        Some("webm") => "video/webm",
        Some("mkv") => "video/x-matroska",
        Some("mp3") => "audio/mpeg",
        Some("m4a") => "audio/mp4",
        Some("wav") => "audio/wav",
        _ => "application/octet-stream",
    }
}

fn parse_range(raw: &str, total: u64) -> Option<(u64, u64)> {
    let spec = raw.trim().strip_prefix("bytes=")?;
    let (start, end) = spec.split_once('-')?;
    let start = start.trim();
    let end = end.trim();
    if start.is_empty() {
        // Suffix range: the last N bytes.
        let suffix: u64 = end.parse().ok()?;
        let start = total.saturating_sub(suffix);
        return Some((start, total.saturating_sub(1)));
    }
    let start: u64 = start.parse().ok()?;
    let end: u64 = if end.is_empty() {
        total.saturating_sub(1)
    } else {
        end.parse().ok()?
    };
    if start > end || end >= total {
        return None;
    }
    Some((start, end))
}

#[cfg(test)]
mod tests {
    use super::{parse_range, serve_media};
    use std::io::{Read, Write};
    use std::net::TcpStream;

    #[test]
    fn parses_byte_ranges() {
        assert_eq!(parse_range("bytes=0-99", 1000), Some((0, 99)));
        assert_eq!(parse_range("bytes=500-", 1000), Some((500, 999)));
        assert_eq!(parse_range("bytes=-100", 1000), Some((900, 999)));
        assert_eq!(parse_range("bytes=900-1100", 1000), None);
        assert_eq!(parse_range("nonsense", 1000), None);
    }

    fn request(url: &str, range: Option<&str>) -> (String, Vec<u8>) {
        let address = url.strip_prefix("http://").unwrap();
        let (host, token) = address.split_once('/').unwrap();
        let mut stream = TcpStream::connect(host).unwrap();
        let mut request = format!("GET /{token} HTTP/1.1\r\nHost: {host}\r\n");
        if let Some(range) = range {
            request.push_str(&format!("Range: {range}\r\n"));
        }
        request.push_str("\r\n");
        stream.write_all(request.as_bytes()).unwrap();
        let mut response = Vec::new();
        stream.read_to_end(&mut response).unwrap();
        let split = response.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
        (
            String::from_utf8_lossy(&response[..split]).into_owned(),
            response[split + 4..].to_vec(),
        )
    }

    #[test]
    fn serves_full_and_partial_content() {
        let dir = std::env::temp_dir().join("dialogue-cut-media-server-test");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("clip.mp4");
        std::fs::write(&file, b"0123456789").unwrap();

        let url = serve_media(&file).unwrap();
        let (headers, body) = request(&url, None);
        assert!(headers.starts_with("HTTP/1.1 200 OK"), "{headers}");
        assert!(headers.contains("Content-Type: video/mp4"), "{headers}");
        assert_eq!(body, b"0123456789");

        let (headers, body) = request(&url, Some("bytes=2-5"));
        assert!(headers.starts_with("HTTP/1.1 206"), "{headers}");
        assert!(headers.contains("Content-Range: bytes 2-5/10"), "{headers}");
        assert_eq!(body, b"2345");

        let (headers, _) = request(&format!("{url}-wrong-token"), None);
        assert!(headers.starts_with("HTTP/1.1 404"), "{headers}");

        let _ = std::fs::remove_dir_all(&dir);
    }
}

fn handle_connection(stream: TcpStream) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut request_line = String::new();
    reader.read_line(&mut request_line)?;
    let token = request_line
        .split_whitespace()
        .nth(1)
        .unwrap_or("")
        .trim_start_matches('/')
        .to_string();

    let mut range_header = None;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 || line.trim().is_empty() {
            break;
        }
        if let Some(value) = line.to_ascii_lowercase().strip_prefix("range:") {
            range_header = Some(value.trim().to_string());
            // Keep reading until the blank line that ends the headers.
        }
        let _ = line;
    }

    let mut stream = stream;
    let path = server()
        .ok()
        .and_then(|server| server.files.lock().ok()?.get(&token).cloned());
    let Some(path) = path else {
        stream.write_all(b"HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n")?;
        return Ok(());
    };

    let mut file = std::fs::File::open(&path)?;
    let total = file.metadata()?.len();
    let content_type = content_type(&path);

    let (start, end, status) = match range_header.as_deref().and_then(|raw| parse_range(raw, total))
    {
        Some((start, end)) => (start, end, "206 Partial Content"),
        None => (0, total.saturating_sub(1), "200 OK"),
    };
    let length = end - start + 1;

    let mut headers = format!(
        "HTTP/1.1 {status}\r\nAccept-Ranges: bytes\r\nContent-Type: {content_type}\r\nContent-Length: {length}\r\nConnection: close\r\n"
    );
    if status.starts_with("206") {
        headers.push_str(&format!("Content-Range: bytes {start}-{end}/{total}\r\n"));
    }
    headers.push_str("\r\n");
    stream.write_all(headers.as_bytes())?;

    file.seek(SeekFrom::Start(start))?;
    std::io::copy(&mut file.take(length), &mut stream)?;
    Ok(())
}
