use pdfium_protocol::{encode, parse_header, read_u16, read_u32, Frame, Kind, OPEN_ACK_LEN};
use std::{
    fs,
    io::{Read, Write},
    path::PathBuf,
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

fn dll_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../src-tauri/resources/pdfium/pdfium.dll")
}
fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/smoke-one-page.pdf")
}
fn two_page_fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/smoke-two-page.pdf")
}
fn exe() -> &'static str {
    env!("CARGO_BIN_EXE_pdfium-worker")
}

#[test]
fn server_startup_rejects_a_missing_pdfium_library_before_ready() {
    let missing =
        std::env::temp_dir().join(format!("lithexpdf-missing-{}.dll", std::process::id()));
    let output = Command::new(exe())
        .args(["--serve", "--pdfium-path"])
        .arg(missing)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(
        output.stdout.is_empty(),
        "invalid startup must not emit READY"
    );
    assert!(String::from_utf8_lossy(&output.stderr).contains("does not exist"));
}

fn read_frame(out: &mut impl Read) -> Frame {
    let mut header = [0; 20];
    out.read_exact(&mut header).unwrap();
    let parsed = parse_header(&header).unwrap();
    let mut payload = vec![0; parsed.payload_len];
    out.read_exact(&mut payload).unwrap();
    Frame {
        kind: parsed.kind,
        request_id: parsed.request_id,
        payload,
    }
}
fn send(child: &mut Child, frame: Frame) {
    let bytes = encode(&frame).unwrap();
    child.stdin.as_mut().unwrap().write_all(&bytes).unwrap();
    child.stdin.as_mut().unwrap().flush().unwrap();
}
fn wait_exit(child: &mut Child) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if child.try_wait().unwrap().is_some() {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "worker did not exit within 5 seconds"
        );
        thread::sleep(Duration::from_millis(15));
    }
}

#[test]
fn real_worker_runs_ready_open_render_close_and_shutdown_binary_protocol() {
    let mut child = Command::new(exe())
        .args(["--serve", "--pdfium-path"])
        .arg(dll_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut out = child.stdout.take().unwrap();
    assert_eq!(
        read_frame(&mut out),
        Frame {
            kind: Kind::Ready,
            request_id: 0,
            payload: vec![]
        }
    );

    let tab = [0x11u8; 16];
    let generation = 7u64;
    let fixture = fixture_path();
    let path = fixture.to_str().unwrap().as_bytes();
    let mut open = tab.to_vec();
    open.extend_from_slice(&generation.to_be_bytes());
    open.extend_from_slice(&(path.len() as u32).to_be_bytes());
    open.extend_from_slice(path);
    send(
        &mut child,
        Frame {
            kind: Kind::Open,
            request_id: 1,
            payload: open,
        },
    );
    let ack = read_frame(&mut out);
    assert_eq!(ack.kind, Kind::Ack);
    assert_eq!(ack.request_id, 1);
    assert_eq!(ack.payload.len(), OPEN_ACK_LEN);
    assert_eq!(read_u32(&ack.payload, 24).unwrap(), 1);

    let mut render = tab.to_vec();
    render.extend_from_slice(&generation.to_be_bytes());
    render.extend_from_slice(&0u32.to_be_bytes());
    render.extend_from_slice(&1.0f64.to_be_bytes());
    render.extend_from_slice(&200u32.to_be_bytes());
    render.extend_from_slice(&120u32.to_be_bytes());
    render.extend_from_slice(&[0, 0, 0, 0]);
    send(
        &mut child,
        Frame {
            kind: Kind::Render,
            request_id: 2,
            payload: render,
        },
    );
    let page = read_frame(&mut out);
    assert_eq!(page.kind, Kind::Page);
    assert_eq!(page.request_id, 2);
    assert_eq!(read_u32(&page.payload, 28).unwrap(), 200);
    assert_eq!(read_u32(&page.payload, 32).unwrap(), 120);
    assert_eq!(&page.payload[42..46], &[0x89, 0x50, 0x4e, 0x47]);

    let mut close = tab.to_vec();
    close.extend_from_slice(&generation.to_be_bytes());
    send(
        &mut child,
        Frame {
            kind: Kind::Close,
            request_id: 3,
            payload: close.clone(),
        },
    );
    let ack = read_frame(&mut out);
    assert_eq!(
        ack,
        Frame {
            kind: Kind::Ack,
            request_id: 3,
            payload: close
        }
    );
    send(
        &mut child,
        Frame {
            kind: Kind::Shutdown,
            request_id: 4,
            payload: vec![],
        },
    );
    assert_eq!(
        read_frame(&mut out),
        Frame {
            kind: Kind::Ack,
            request_id: 4,
            payload: vec![]
        }
    );
    wait_exit(&mut child);
}

#[test]
fn corrupt_pdf_returns_bounded_error_and_worker_remains_shutdown_capable() {
    let path = std::env::temp_dir().join(format!("lithexpdf-corrupt-{}.pdf", std::process::id()));
    fs::write(&path, b"not a pdf").unwrap();
    let mut child = Command::new(exe())
        .args(["--serve", "--pdfium-path"])
        .arg(dll_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut out = child.stdout.take().unwrap();
    assert_eq!(read_frame(&mut out).kind, Kind::Ready);
    let tab = [0x22u8; 16];
    let path_bytes = path.to_str().unwrap().as_bytes();
    let mut payload = tab.to_vec();
    payload.extend_from_slice(&1u64.to_be_bytes());
    payload.extend_from_slice(&(path_bytes.len() as u32).to_be_bytes());
    payload.extend_from_slice(path_bytes);
    send(
        &mut child,
        Frame {
            kind: Kind::Open,
            request_id: 8,
            payload,
        },
    );
    let error = read_frame(&mut out);
    assert_eq!(error.kind, Kind::Error);
    assert_eq!(error.request_id, 8);
    assert!(error.payload.len() >= 4 && error.payload.len() <= 4100);
    assert_eq!(u16::from_be_bytes([error.payload[0], error.payload[1]]), 5);
    send(
        &mut child,
        Frame {
            kind: Kind::Shutdown,
            request_id: 9,
            payload: vec![],
        },
    );
    assert_eq!(read_frame(&mut out).kind, Kind::Ack);
    wait_exit(&mut child);
    let _ = fs::remove_file(path);
}

#[test]
fn one_worker_can_switch_between_fifty_documents_without_retaining_native_handles() {
    let mut child = Command::new(exe())
        .args(["--serve", "--pdfium-path"])
        .arg(dll_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut out = child.stdout.take().unwrap();
    assert_eq!(read_frame(&mut out).kind, Kind::Ready);
    let path = fixture_path();
    let path_bytes = path.to_str().unwrap().as_bytes();
    for iteration in 1u64..=50 {
        let tab = iteration.to_be_bytes().repeat(2);
        let mut open = tab.clone();
        open.extend_from_slice(&iteration.to_be_bytes());
        open.extend_from_slice(&(path_bytes.len() as u32).to_be_bytes());
        open.extend_from_slice(path_bytes);
        send(
            &mut child,
            Frame {
                kind: Kind::Open,
                request_id: iteration * 2,
                payload: open,
            },
        );
        let ack = read_frame(&mut out);
        assert_eq!(ack.kind, Kind::Ack);
        assert_eq!(ack.request_id, iteration * 2);
        assert_eq!(read_u32(&ack.payload, 24).unwrap(), 1);

        let mut close = tab;
        close.extend_from_slice(&iteration.to_be_bytes());
        send(
            &mut child,
            Frame {
                kind: Kind::Close,
                request_id: iteration * 2 + 1,
                payload: close.clone(),
            },
        );
        assert_eq!(
            read_frame(&mut out),
            Frame {
                kind: Kind::Ack,
                request_id: iteration * 2 + 1,
                payload: close
            }
        );
    }
    send(
        &mut child,
        Frame {
            kind: Kind::Shutdown,
            request_id: 102,
            payload: vec![],
        },
    );
    assert_eq!(read_frame(&mut out).kind, Kind::Ack);
    wait_exit(&mut child);
}

#[test]
fn worker_reports_two_page_metadata_and_renders_second_page() {
    let mut child = Command::new(exe())
        .args(["--serve", "--pdfium-path"])
        .arg(dll_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut out = child.stdout.take().unwrap();
    assert_eq!(read_frame(&mut out).kind, Kind::Ready);
    let tab = [0x33u8; 16];
    let path = two_page_fixture_path();
    let path_bytes = path.to_str().unwrap().as_bytes();
    let mut open = tab.to_vec();
    open.extend_from_slice(&3u64.to_be_bytes());
    open.extend_from_slice(&(path_bytes.len() as u32).to_be_bytes());
    open.extend_from_slice(path_bytes);
    send(
        &mut child,
        Frame {
            kind: Kind::Open,
            request_id: 1,
            payload: open,
        },
    );
    let ack = read_frame(&mut out);
    assert_eq!(ack.kind, Kind::Ack);
    assert_eq!(read_u32(&ack.payload, 24).unwrap(), 2);
    let mut render = tab.to_vec();
    render.extend_from_slice(&3u64.to_be_bytes());
    render.extend_from_slice(&1u32.to_be_bytes());
    render.extend_from_slice(&1.0f64.to_be_bytes());
    render.extend_from_slice(&300u32.to_be_bytes());
    render.extend_from_slice(&420u32.to_be_bytes());
    render.extend_from_slice(&[0, 0, 0, 0]);
    send(
        &mut child,
        Frame {
            kind: Kind::Render,
            request_id: 2,
            payload: render,
        },
    );
    let page = read_frame(&mut out);
    assert_eq!(page.kind, Kind::Page);
    assert_eq!(read_u32(&page.payload, 24).unwrap(), 1);

    let query = b"LitheXPDF";
    let mut search = tab.to_vec();
    search.extend_from_slice(&3u64.to_be_bytes());
    search.push(0);
    search.extend_from_slice(&(query.len() as u16).to_be_bytes());
    search.extend_from_slice(query);
    send(
        &mut child,
        Frame {
            kind: Kind::Search,
            request_id: 3,
            payload: search,
        },
    );
    let results = read_frame(&mut out);
    assert_eq!(results.kind, Kind::SearchResults);
    assert_eq!(results.request_id, 3);
    assert_eq!(&results.payload[..16], &tab);
    assert_eq!(read_u16(&results.payload, 24).unwrap(), 2);
    assert_eq!(results.payload[26], 0);
    let mut offset = 28;
    let mut found_pages = Vec::new();
    for _ in 0..2 {
        found_pages.push(read_u32(&results.payload, offset).unwrap());
        let text_len = read_u16(&results.payload, offset + 4).unwrap() as usize;
        offset += 6;
        let text = std::str::from_utf8(&results.payload[offset..offset + text_len]).unwrap();
        assert!(text.contains("LitheXPDF"));
        offset += text_len;
    }
    assert_eq!(found_pages, vec![0, 1]);
    assert_eq!(offset, results.payload.len());

    for (request_id, query, flags, expected_count) in
        [(4, &b"lithexpdf"[..], 0b01, 0), (5, &b"page"[..], 0b10, 2)]
    {
        let mut payload = tab.to_vec();
        payload.extend_from_slice(&3u64.to_be_bytes());
        payload.push(flags);
        payload.extend_from_slice(&(query.len() as u16).to_be_bytes());
        payload.extend_from_slice(query);
        send(
            &mut child,
            Frame {
                kind: Kind::Search,
                request_id,
                payload,
            },
        );
        let results = read_frame(&mut out);
        assert_eq!(results.kind, Kind::SearchResults);
        assert_eq!(results.request_id, request_id);
        assert_eq!(read_u16(&results.payload, 24).unwrap(), expected_count);
    }

    send(
        &mut child,
        Frame {
            kind: Kind::Shutdown,
            request_id: 6,
            payload: vec![],
        },
    );
    assert_eq!(read_frame(&mut out).kind, Kind::Ack);
    wait_exit(&mut child);
}
