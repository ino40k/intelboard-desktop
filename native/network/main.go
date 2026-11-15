// IntelBoard's transport-only child process. No board data, filesystem paths,
// signing authority, shell execution, or desktop APIs are accepted from peers.
package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"sync"
	"time"

	"github.com/tailscale/tailcat"
	"tailscale.com/tailcfg"
	"tailscale.com/types/key"
)

const maxFrame = 4 * 1024 * 1024
const controlPort = 47381
const bulkPort = 47382

type configuration struct {
	Key    key.NodePrivate      `json:"key"`
	PSK    tailcat.PresharedKey `json:"psk"`
	Region *tailcfg.DERPRegion  `json:"region,omitempty"`
}
type command struct {
	Op      string          `json:"op"`
	Request string          `json:"request"`
	Config  configuration   `json:"config"`
	Address tailcat.Addr    `json:"address"`
	Lane    string          `json:"lane"`
	ID      string          `json:"id"`
	Frame   json.RawMessage `json:"frame"`
}
type connection struct {
	net.Conn
	mu     sync.Mutex
	client *tailcat.Client
}
type engine struct {
	ctx     context.Context
	cancel  context.CancelFunc
	mu      sync.Mutex
	output  sync.Mutex
	server  *tailcat.Server
	conns   map[string]*connection
	config  configuration
	started bool
	wg      sync.WaitGroup
}

func randomID() string { b := make([]byte, 16); _, _ = rand.Read(b); return hex.EncodeToString(b) }
func (e *engine) emit(data any) {
	e.output.Lock()
	defer e.output.Unlock()
	b, err := json.Marshal(data)
	if err == nil {
		_, _ = os.Stdout.Write(append(b, '\n'))
	}
}
func (e *engine) answer(request string, data any, err error) {
	message := map[string]any{"event": "reply", "request": request}
	if err != nil {
		message["error"] = err.Error()
	} else {
		message["result"] = data
	}
	e.emit(message)
}
func validateAddress(address tailcat.Addr) (tailcat.ConnInfo, error) {
	if len(address) > 4096 {
		return tailcat.ConnInfo{}, errors.New("peer address exceeds limit")
	}
	ci, err := tailcat.ParseAddr(address)
	if err != nil || ci.ServerPublic.IsZero() || ci.ServerDiscoPublic.IsZero() || ci.PresharedKey.IsZero() || ci.RegionID <= 0 || len(ci.Region) != 0 {
		return tailcat.ConnInfo{}, errors.New("invalid peer address")
	}
	return ci, nil
}
func (e *engine) start(config configuration) {
	defer e.wg.Done()
	if config.Key.IsZero() {
		config.Key = key.NewNode()
	}
	if config.PSK.IsZero() {
		config.PSK = tailcat.NewPresharedKey()
	}
	e.config = config
	e.emit(map[string]any{"event": "identity", "config": config})
	for e.ctx.Err() == nil {
		ctx, cancel := context.WithTimeout(e.ctx, 15*time.Second)
		var err error
		if _, err = net.Interfaces(); err == nil && config.Region == nil {
			ci := &tailcat.ConnInfo{RegionID: -1}
			err = ci.Expand(ctx, tailcat.ExpandForServer)
			if err == nil && len(ci.Region) == 1 {
				config.Region = ci.Region[0]
			} else if err == nil {
				err = errors.New("no relay available")
			}
		}
		if err != nil {
			cancel()
			e.emit(map[string]any{"event": "unavailable", "message": "Peer networking is unavailable; retrying while the app is open"})
			select {
			case <-e.ctx.Done():
				return
			case <-time.After(15 * time.Second):
				continue
			}
		}
		server := &tailcat.Server{Key: config.Key, PresharedKey: config.PSK, Region: config.Region, Logf: func(string, ...any) {}}
		control, err := server.Listen(ctx, "tcp", fmt.Sprintf(":%d", controlPort))
		var bulk net.Listener
		if err == nil {
			bulk, err = server.Listen(ctx, "tcp", fmt.Sprintf(":%d", bulkPort))
		}
		cancel()
		if err != nil {
			if control != nil {
				control.Close()
			}
			server.Close()
			e.emit(map[string]any{"event": "unavailable", "message": "Could not reach peer relays; retrying"})
			select {
			case <-e.ctx.Done():
				return
			case <-time.After(15 * time.Second):
				continue
			}
		}
		e.mu.Lock()
		if e.ctx.Err() != nil {
			e.mu.Unlock()
			control.Close()
			bulk.Close()
			server.Close()
			return
		}
		e.server = server
		e.config = config
		e.mu.Unlock()
		address := (&tailcat.ConnInfo{ServerPublic: tailcat.NodePublic{NodePublic: config.Key.Public()}, ServerDiscoPublic: tailcat.DiscoPublicForNode(config.Key), PresharedKey: config.PSK, RegionID: config.Region.RegionID}).Addr()
		e.emit(map[string]any{"event": "ready", "address": address, "nodeKey": config.Key.Public().String(), "config": config})
		e.wg.Add(2)
		go e.accept(control, "control", server)
		go e.accept(bulk, "bulk", server)
		return
	}
}
func (e *engine) accept(listener net.Listener, lane string, server *tailcat.Server) {
	defer e.wg.Done()
	for {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		peer, ok := server.PeerKey(conn.RemoteAddr())
		if !ok {
			conn.Close()
			continue
		}
		e.admit(conn, lane, peer.String(), e.config.Key.Public().String(), nil, "")
	}
}
func (e *engine) admit(conn net.Conn, lane, peer, local string, client *tailcat.Client, request string) {
	e.mu.Lock()
	if len(e.conns) >= 64 || e.ctx.Err() != nil {
		e.mu.Unlock()
		conn.Close()
		if client != nil {
			client.Close()
		}
		if request != "" {
			e.answer(request, nil, errors.New("connection limit reached"))
		}
		return
	}
	id := randomID()
	c := &connection{Conn: conn, client: client}
	e.conns[id] = c
	e.wg.Add(1)
	e.mu.Unlock()
	// Connection metadata is authenticated by Tailcat, not supplied by the peer's
	// JSON. The parent binds it to an Ed25519-signed application handshake.
	event := map[string]any{"event": "connected", "id": id, "lane": lane, "peerKey": peer, "localKey": local, "outbound": client != nil}
	if request != "" {
		e.answer(request, event, nil)
	} else {
		e.emit(event)
	}
	go func() {
		defer e.wg.Done()
		defer e.disconnect(id)
		scan := bufio.NewScanner(conn)
		scan.Buffer(make([]byte, 4096), maxFrame)
		for scan.Scan() {
			b := append([]byte{}, scan.Bytes()...)
			if !json.Valid(b) {
				return
			}
			e.emit(map[string]any{"event": "frame", "id": id, "frame": json.RawMessage(b)})
		}
	}()
}
func (e *engine) dial(c command) {
	defer e.wg.Done()
	ci, err := validateAddress(c.Address)
	if err != nil {
		e.answer(c.Request, nil, err)
		return
	}
	port := controlPort
	if c.Lane == "bulk" {
		port = bulkPort
	} else if c.Lane != "control" {
		e.answer(c.Request, nil, errors.New("invalid channel"))
		return
	}
	// Distinct client keys prevent simultaneous magicsock instances from competing
	// for the listener's persistent DERP identity (the same pattern as Handoff).
	local := key.NewNode()
	client := &tailcat.Client{Server: c.Address, Key: local, Logf: func(string, ...any) {}}
	ctx, cancel := context.WithTimeout(e.ctx, 12*time.Second)
	defer cancel()
	conn, err := client.DialTCPPort(ctx, uint16(port))
	if err != nil {
		client.Close()
		e.answer(c.Request, nil, errors.New("peer is unreachable; retry when a collaborator is online"))
		return
	}
	e.admit(conn, c.Lane, ci.ServerPublic.NodePublic.String(), local.Public().String(), client, c.Request)
}
func (e *engine) disconnect(id string) {
	e.mu.Lock()
	c := e.conns[id]
	delete(e.conns, id)
	e.mu.Unlock()
	if c != nil {
		c.Close()
		if c.client != nil {
			c.client.Close()
		}
		e.emit(map[string]any{"event": "disconnected", "id": id})
	}
}
func (e *engine) handle(c command) {
	switch c.Op {
	case "start":
		e.mu.Lock()
		if e.started {
			e.mu.Unlock()
			e.answer(c.Request, nil, errors.New("already started"))
			return
		}
		e.started = true
		e.wg.Add(1)
		e.mu.Unlock()
		go e.start(c.Config)
		e.answer(c.Request, true, nil)
	case "dial":
		e.mu.Lock()
		if !e.started || e.ctx.Err() != nil {
			e.mu.Unlock()
			e.answer(c.Request, nil, errors.New("network is stopped"))
			return
		}
		e.wg.Add(1)
		e.mu.Unlock()
		go e.dial(c)
	case "send":
		e.mu.Lock()
		conn := e.conns[c.ID]
		e.mu.Unlock()
		if conn == nil {
			e.answer(c.Request, nil, errors.New("connection closed"))
			return
		}
		if len(c.Frame) > maxFrame-1 || !json.Valid(c.Frame) {
			e.answer(c.Request, nil, errors.New("invalid frame size"))
			return
		}
		e.wg.Add(1)
		go func() {
			defer e.wg.Done()
			conn.mu.Lock()
			conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			_, err := conn.Write(append(c.Frame, '\n'))
			conn.mu.Unlock()
			if err != nil {
				e.disconnect(c.ID)
			}
			e.answer(c.Request, true, err)
		}()
	case "close":
		e.disconnect(c.ID)
		e.answer(c.Request, true, nil)
	default:
		e.answer(c.Request, nil, errors.New("unknown transport operation"))
	}
}
func main() {
	ctx, cancel := context.WithCancel(context.Background())
	e := &engine{ctx: ctx, cancel: cancel, conns: map[string]*connection{}}
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 4096), maxFrame+16384)
	for scanner.Scan() {
		var c command
		if json.Unmarshal(scanner.Bytes(), &c) != nil {
			break
		}
		e.handle(c)
	}
	cancel()
	e.mu.Lock()
	server := e.server
	ids := make([]string, 0, len(e.conns))
	for id := range e.conns {
		ids = append(ids, id)
	}
	e.mu.Unlock()
	if server != nil {
		server.Close()
	}
	for _, id := range ids {
		e.disconnect(id)
	}
	e.wg.Wait()
}
