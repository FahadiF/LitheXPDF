use std::fmt;

pub const MAGIC: [u8; 4] = *b"PDFW";
pub const VERSION: u16 = 2;
pub const HEADER_LEN: usize = 20;
pub const MAX_CONTROL_PAYLOAD: usize = 64 * 1024;
pub const MAX_IMAGE_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_RESULT_METADATA: usize = 4 * 1024;
pub const MAX_RESULT_PAYLOAD: usize = MAX_IMAGE_BYTES + MAX_RESULT_METADATA;
pub const MAX_BITMAP_DIMENSION: u32 = 8_192;
pub const MAX_BITMAP_PIXELS: u64 = 8_388_608;
pub const MAX_RGBA_BYTES: u64 = 32 * 1024 * 1024;
pub const MAX_SEARCH_QUERY_BYTES: usize = 512;
pub const MAX_SEARCH_RESULTS: usize = 250;
pub const MAX_SEARCH_EXCERPT_BYTES: usize = 128;
pub const OPEN_ACK_LEN: usize = 44;
pub const PAGE_METADATA_LEN: usize = 42;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u16)]
pub enum Kind {
    Open = 0x0001,
    Render = 0x0002,
    Close = 0x0003,
    Shutdown = 0x0004,
    Search = 0x0005,
    Print = 0x0006,
    GetTextLayer = 0x0007,
    Ready = 0x8001,
    Ack = 0x8002,
    Page = 0x8003,
    SearchResults = 0x8004,
    PrintResult = 0x8005,
    TextLayer = 0x8006,
    Error = 0x80ff,
}

pub const MAX_TEXT_LAYER_BYTES: usize = 60 * 1024;

impl TryFrom<u16> for Kind {
    type Error = ProtocolError;
    fn try_from(value: u16) -> Result<Self, ProtocolError> {
        match value {
            0x0001 => Ok(Self::Open),
            0x0002 => Ok(Self::Render),
            0x0003 => Ok(Self::Close),
            0x0004 => Ok(Self::Shutdown),
            0x0005 => Ok(Self::Search),
            0x0006 => Ok(Self::Print),
            0x0007 => Ok(Self::GetTextLayer),
            0x8001 => Ok(Self::Ready),
            0x8002 => Ok(Self::Ack),
            0x8003 => Ok(Self::Page),
            0x8004 => Ok(Self::SearchResults),
            0x8005 => Ok(Self::PrintResult),
            0x8006 => Ok(Self::TextLayer),
            0x80ff => Ok(Self::Error),
            _ => Err(ProtocolError::UnknownKind(value)),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Frame {
    pub kind: Kind,
    pub request_id: u64,
    pub payload: Vec<u8>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Header {
    pub kind: Kind,
    pub request_id: u64,
    pub payload_len: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProtocolError {
    BadMagic,
    UnsupportedVersion(u16),
    UnknownKind(u16),
    ZeroRequestId,
    InvalidRequestId,
    PayloadTooLarge { kind: Kind, length: usize },
    TruncatedHeader,
    TruncatedPayload,
    InvalidPayload(&'static str),
    LengthOverflow,
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for ProtocolError {}

pub fn encode(frame: &Frame) -> Result<Vec<u8>, ProtocolError> {
    validate_request_id(frame.kind, frame.request_id)?;
    let limit = payload_limit(frame.kind);
    if frame.payload.len() > limit {
        return Err(ProtocolError::PayloadTooLarge {
            kind: frame.kind,
            length: frame.payload.len(),
        });
    }
    let total = HEADER_LEN
        .checked_add(frame.payload.len())
        .ok_or(ProtocolError::LengthOverflow)?;
    let mut out = Vec::with_capacity(total);
    out.extend_from_slice(&MAGIC);
    out.extend_from_slice(&VERSION.to_be_bytes());
    out.extend_from_slice(&(frame.kind as u16).to_be_bytes());
    out.extend_from_slice(&frame.request_id.to_be_bytes());
    out.extend_from_slice(&(frame.payload.len() as u32).to_be_bytes());
    out.extend_from_slice(&frame.payload);
    Ok(out)
}

fn validate_request_id(kind: Kind, id: u64) -> Result<(), ProtocolError> {
    if kind == Kind::Ready {
        if id != 0 {
            return Err(ProtocolError::InvalidRequestId);
        }
    } else if id == 0 {
        return Err(ProtocolError::ZeroRequestId);
    }
    Ok(())
}

fn payload_limit(kind: Kind) -> usize {
    if kind == Kind::Page {
        MAX_RESULT_PAYLOAD
    } else if kind == Kind::TextLayer {
        MAX_TEXT_LAYER_BYTES
    } else {
        MAX_CONTROL_PAYLOAD
    }
}

pub struct Decoder {
    buffered: Vec<u8>,
    failed: bool,
}

impl Default for Decoder {
    fn default() -> Self {
        Self::new()
    }
}
impl Decoder {
    pub fn new() -> Self {
        Self {
            buffered: Vec::new(),
            failed: false,
        }
    }

    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<Frame>, ProtocolError> {
        if self.failed {
            return Err(ProtocolError::InvalidPayload("decoder already failed"));
        }
        let mut frames = Vec::new();
        for chunk in bytes.chunks(8192) {
            self.buffered.extend_from_slice(chunk);
            loop {
                if self.buffered.len() < HEADER_LEN {
                    break;
                }
                let header = match parse_header(&self.buffered[..HEADER_LEN]) {
                    Ok(v) => v,
                    Err(e) => {
                        self.failed = true;
                        self.buffered.clear();
                        return Err(e);
                    }
                };
                let total = match HEADER_LEN.checked_add(header.payload_len) {
                    Some(v) => v,
                    None => {
                        self.failed = true;
                        self.buffered.clear();
                        return Err(ProtocolError::LengthOverflow);
                    }
                };
                if self.buffered.len() < total {
                    break;
                }
                let payload = self.buffered[HEADER_LEN..total].to_vec();
                self.buffered.drain(..total);
                frames.push(Frame {
                    kind: header.kind,
                    request_id: header.request_id,
                    payload,
                });
            }
            if self.buffered.len() > HEADER_LEN + MAX_RESULT_PAYLOAD {
                self.failed = true;
                self.buffered.clear();
                return Err(ProtocolError::InvalidPayload(
                    "decoder buffer exceeded the maximum frame size",
                ));
            }
        }
        Ok(frames)
    }

    pub fn finish(&mut self) -> Result<(), ProtocolError> {
        if self.buffered.is_empty() {
            Ok(())
        } else {
            self.failed = true;
            Err(if self.buffered.len() < HEADER_LEN {
                ProtocolError::TruncatedHeader
            } else {
                ProtocolError::TruncatedPayload
            })
        }
    }
}

pub fn parse_header(bytes: &[u8]) -> Result<Header, ProtocolError> {
    if bytes.len() != HEADER_LEN {
        return Err(ProtocolError::TruncatedHeader);
    }
    if bytes[0..4] != MAGIC {
        return Err(ProtocolError::BadMagic);
    }
    let version = u16::from_be_bytes([bytes[4], bytes[5]]);
    if version != VERSION {
        return Err(ProtocolError::UnsupportedVersion(version));
    }
    let kind = Kind::try_from(u16::from_be_bytes([bytes[6], bytes[7]]))?;
    let request_id = u64::from_be_bytes(
        bytes[8..16]
            .try_into()
            .map_err(|_| ProtocolError::TruncatedHeader)?,
    );
    validate_request_id(kind, request_id)?;
    let length = u32::from_be_bytes(
        bytes[16..20]
            .try_into()
            .map_err(|_| ProtocolError::TruncatedHeader)?,
    ) as usize;
    let limit = payload_limit(kind);
    if length > limit {
        return Err(ProtocolError::PayloadTooLarge { kind, length });
    }
    Ok(Header {
        kind,
        request_id,
        payload_len: length,
    })
}

pub fn read_u32(bytes: &[u8], at: usize) -> Result<u32, ProtocolError> {
    let end = at.checked_add(4).ok_or(ProtocolError::LengthOverflow)?;
    Ok(u32::from_be_bytes(
        bytes
            .get(at..end)
            .ok_or(ProtocolError::InvalidPayload("missing u32"))?
            .try_into()
            .map_err(|_| ProtocolError::InvalidPayload("missing u32"))?,
    ))
}
pub fn read_u16(bytes: &[u8], at: usize) -> Result<u16, ProtocolError> {
    let end = at.checked_add(2).ok_or(ProtocolError::LengthOverflow)?;
    Ok(u16::from_be_bytes(
        bytes
            .get(at..end)
            .ok_or(ProtocolError::InvalidPayload("missing u16"))?
            .try_into()
            .map_err(|_| ProtocolError::InvalidPayload("missing u16"))?,
    ))
}
pub fn read_u64(bytes: &[u8], at: usize) -> Result<u64, ProtocolError> {
    let end = at.checked_add(8).ok_or(ProtocolError::LengthOverflow)?;
    Ok(u64::from_be_bytes(
        bytes
            .get(at..end)
            .ok_or(ProtocolError::InvalidPayload("missing u64"))?
            .try_into()
            .map_err(|_| ProtocolError::InvalidPayload("missing u64"))?,
    ))
}
pub fn put_u32(out: &mut Vec<u8>, value: u32) {
    out.extend_from_slice(&value.to_be_bytes());
}
pub fn put_u64(out: &mut Vec<u8>, value: u64) {
    out.extend_from_slice(&value.to_be_bytes());
}

pub fn validate_bitmap(width: u32, height: u32) -> Result<(), ProtocolError> {
    let pixels = u64::from(width)
        .checked_mul(u64::from(height))
        .ok_or(ProtocolError::LengthOverflow)?;
    if width == 0
        || height == 0
        || width > MAX_BITMAP_DIMENSION
        || height > MAX_BITMAP_DIMENSION
        || pixels > MAX_BITMAP_PIXELS
        || pixels.checked_mul(4).ok_or(ProtocolError::LengthOverflow)? > MAX_RGBA_BYTES
    {
        return Err(ProtocolError::InvalidPayload(
            "bitmap dimensions exceed limits",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(kind: Kind, id: u64, payload: &[u8]) -> Frame {
        Frame {
            kind,
            request_id: id,
            payload: payload.to_vec(),
        }
    }

    #[test]
    fn encodes_big_endian_header_and_decodes_partial_and_coalesced_frames() {
        let a = encode(&frame(Kind::Ready, 0, &[])).unwrap();
        let b = encode(&frame(Kind::Ack, 9, b"ok")).unwrap();
        assert_eq!(&a[..4], b"PDFW");
        assert_eq!(&a[4..6], &VERSION.to_be_bytes());
        let mut decoder = Decoder::new();
        assert!(decoder.push(&a[..7]).unwrap().is_empty());
        let mut rest = a[7..].to_vec();
        rest.extend_from_slice(&b);
        assert_eq!(
            decoder.push(&rest).unwrap(),
            vec![frame(Kind::Ready, 0, &[]), frame(Kind::Ack, 9, b"ok")]
        );
        decoder.finish().unwrap();
    }

    #[test]
    fn recognizes_bounded_search_request_and_response_kinds() {
        let query = b"LitheXPDF";
        let mut payload = vec![0x44; 16];
        payload.extend_from_slice(&3u64.to_be_bytes());
        payload.push(0b01);
        payload.extend_from_slice(&(query.len() as u16).to_be_bytes());
        payload.extend_from_slice(query);
        let request = encode(&frame(Kind::Search, 17, &payload)).unwrap();
        let mut decoder = Decoder::new();
        assert_eq!(
            decoder.push(&request).unwrap(),
            vec![frame(Kind::Search, 17, &payload)]
        );
        let response = encode(&frame(Kind::SearchResults, 17, &[0; 28])).unwrap();
        assert_eq!(
            Decoder::new().push(&response).unwrap(),
            vec![frame(Kind::SearchResults, 17, &[0; 28])]
        );
        assert!(encode(&frame(Kind::Search, 18, &vec![0; MAX_CONTROL_PAYLOAD + 1])).is_err());
    }

    #[test]
    fn rejects_bad_magic_version_kind_and_zero_ids() {
        for (bytes, expected) in [
            (
                {
                    let mut b = encode(&frame(Kind::Ready, 0, &[])).unwrap();
                    b[0] = 0;
                    b
                },
                ProtocolError::BadMagic,
            ),
            (
                {
                    let mut b = encode(&frame(Kind::Ready, 0, &[])).unwrap();
                    b[5] = (VERSION + 1) as u8;
                    b
                },
                ProtocolError::UnsupportedVersion(VERSION + 1),
            ),
            (
                {
                    let mut b = encode(&frame(Kind::Ready, 0, &[])).unwrap();
                    b[7] = 8;
                    b
                },
                ProtocolError::UnknownKind(0x8008),
            ),
            (
                {
                    let mut b = encode(&frame(Kind::Ack, 1, &[])).unwrap();
                    b[15] = 0;
                    b
                },
                ProtocolError::ZeroRequestId,
            ),
        ] {
            assert_eq!(Decoder::new().push(&bytes).unwrap_err(), expected);
        }
    }

    #[test]
    fn rejects_oversized_lengths_before_payload_arrives() {
        let mut header = encode(&frame(Kind::Ready, 0, &[])).unwrap();
        header[6..8].copy_from_slice(&(Kind::Page as u16).to_be_bytes());
        header[8..16].copy_from_slice(&1u64.to_be_bytes());
        header[16..20].copy_from_slice(&((MAX_RESULT_PAYLOAD as u32) + 1).to_be_bytes());
        assert!(matches!(
            Decoder::new().push(&header),
            Err(ProtocolError::PayloadTooLarge { .. })
        ));
    }

    #[test]
    fn rejects_truncated_header_and_payload() {
        let mut d = Decoder::new();
        d.push(b"PDF").unwrap();
        assert_eq!(d.finish(), Err(ProtocolError::TruncatedHeader));
        let bytes = encode(&frame(Kind::Ack, 1, b"abcd")).unwrap();
        let mut d = Decoder::new();
        d.push(&bytes[..bytes.len() - 1]).unwrap();
        assert_eq!(d.finish(), Err(ProtocolError::TruncatedPayload));
    }

    #[test]
    fn bitmap_validation_rejects_overflow_and_limits() {
        assert!(validate_bitmap(200, 120).is_ok());
        assert!(validate_bitmap(8192, 8192).is_err());
        assert!(validate_bitmap(u32::MAX, u32::MAX).is_err());
    }
}
