package main

import (
	"github.com/tailscale/tailcat"
	"tailscale.com/tailcfg"
	"tailscale.com/types/key"
	"testing"
)

func TestOnlyPublicCompactAddresses(t *testing.T) {
	node := key.NewNode()
	valid := tailcat.ConnInfo{ServerPublic: tailcat.NodePublic{NodePublic: node.Public()}, ServerDiscoPublic: tailcat.DiscoPublicForNode(node), PresharedKey: tailcat.NewPresharedKey(), RegionID: 1}
	if _, err := validateAddress(valid.Addr()); err != nil {
		t.Fatal(err)
	}
	if _, err := validateAddress("bad address"); err == nil {
		t.Fatal("malformed address accepted")
	}
	valid.Region = []*tailcfg.DERPRegion{{RegionID: 1, RegionCode: "custom"}}
	if _, err := validateAddress(valid.Addr()); err == nil {
		t.Fatal("embedded relay configuration accepted")
	}
	valid.Region = nil
	valid.RegionID = -1
	if _, err := validateAddress(valid.Addr()); err == nil {
		t.Fatal("invalid public region accepted")
	}
}
